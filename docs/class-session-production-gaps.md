# Class Session Production Readiness Gaps

Updated: 2026-07-09

This document tracks the remaining gap between the current class-session implementation and production readiness.

It intentionally separates:

- features that appear implemented and need regression proof
- gaps that should block a controlled pilot
- gaps that should block broader production rollout
- staging and operational proof that cannot be replaced by local builds

## Status Labels

Use these labels instead of relying on color alone. Strikethrough still marks a completed checklist line, but the label makes the status readable in every Markdown renderer.

- **Done**: implemented and verified enough to close the checklist item.
- **Pending Proof**: implemented or partially hardened, but real runtime, screenshot, staging, or browser evidence is still required.
- **Blocker**: must be completed before the relevant pilot or production milestone.
- **Tracked**: important follow-up that should remain visible, but may not block the immediate milestone.

## Current Readiness Estimate

| Target | Estimated readiness | Remaining gap |
| --- | ---: | ---: |
| Internal demo | 92-95% | 5-8% |
| Controlled pilot with small real classes | 82-88% | 12-18% |
| Serious production for paying users | 72-80% | 20-28% |
| Large scale or multi-node production | 58-68% | 32-42% |

The product is now feature-rich, and several previous UX, whiteboard, demo-data, security-configuration, and observability gaps are marked **Done**. The remaining gap is now concentrated in proof and release confidence: build/dev runtime evidence, real teacher/student screenshots, live teacher-media proof, mobile/tablet screenshot proof, staging WebRTC/TURN/UDP validation, backups/retention, soak/load testing, cross-browser behavior, and multi-node production evidence.

## Likely Implemented, But Must Stay Covered By Regression Tests

Status: **Pending Proof**.

These items were listed as gaps in older versions of this document, but code now appears to include implementations for them. They should not be treated as complete without build, unit, integration, and browser proof.

- Dedicated student enrollment source of truth and class-session access checks.
- Lifecycle watch authorization with `sessionId` and targeted `batchId` lookup for planned sessions.
- Manual start/end lifecycle, plus teacher disconnect reconnect grace.
- Private teacher-student chat, explicit teacher broadcast chat, read state, and thread summaries.
- Multi-socket targeted delivery patterns for private chat and moderation.
- Teacher/student media, screen share, whiteboard-as-video share, and device switching.
- Teacher participant cards with student media and moderation controls.
- Bulk teacher controls such as mute all, stop cameras, lock class, end for everyone, and attendance export.
- Class materials, lesson-asset whiteboard import/export, board-note attachments, recording records/playback manifests, and attendance snapshots.
- Student completed-session history, guarded post-class artifacts, private post-class teacher Q&A, and the teacher post-class workspace.
- Selective student whiteboard control and whiteboard command events.
- Admin modules for attendance, recordings, enrollments, users, courses, batches, dashboard, and audit-style operational surfaces.
- Admin class-session operational health snapshots, support-safe diagnostics, support/recording metrics, and dashboard issue surfacing.

## Pilot Blockers

Status: **Blocker** until every P0 item in this section is either **Done** or explicitly accepted as pilot risk.

These should be resolved before inviting real teachers/students into a controlled pilot.

### P0: Build And Dev Runtime Must Be Green

Status: **Blocker**.

Build success alone is not enough. The backend, frontend, admin portal, sockets, auth, and class-session routes must also run in development mode.

Required proof:

- `npm run build --workspace @native-sfu/contracts`
- `npm run build --workspace @native-sfu/backend`
- `npm run build --workspace @native-sfu/frontend`
- `npm run build --workspace @native-sfu/admin-portal`
- backend starts in dev mode and exposes health/API/socket basics
- frontend starts in dev mode and loads teacher/student route shells
- admin portal starts in dev mode and loads dashboard/module route shells
- local runtime smoke proves login/config/API base URLs are correct

Known concern:

- `docs/testing.md` notes local Angular production build issues under some Node/runtime combinations. Use the repo-supported Node 22 path for signoff and do not treat Node 23-only behavior as production proof.

### P0: Real Teacher And Student Screenshots

Status: **Blocker**.

Before pilot, capture real screenshots from the running app, not static mockups.

Required screenshots:

- teacher live class-session default state
- teacher 3-dot menu open
- teacher device settings drawer open
- teacher participant cards with student media states
- teacher whiteboard with toolbar, Math popover, imported PDF/slide page, and annotated notes action if present
- student waiting/prejoin state
- student live state with teacher camera as main stage
- student live state with screen/whiteboard share as main stage and teacher camera PiP
- student chat/materials panels, including attached board notes if feasible
- ended/reconnecting/forbidden states where feasible

### P0: Teacher Media Visibility Must Be Proven

Status: **Blocker**.

The student UI is intended to show:

- teacher camera as main stage when no screen-like source is active
- screen or whiteboard share as main stage when active
- teacher camera as PiP while screen or whiteboard is active

Pilot proof must verify that teacher camera producers are published, consumed, and rendered reliably. A black PiP box is not acceptable. If the stream is unavailable, the UI should show a clear camera-off or connecting state.

### P0: Native Browser Confirms Must Be Replaced

Status: **Done** as of 2026-06-25.

Every checklist item below is fully struck through and marked **Done**.

Destructive teacher actions should not use browser-native `confirm()`. Class-session surfaces should also avoid browser-native `prompt()` / `alert()` for sensitive or workflow-blocking UI.

- **Done**: ~~End for everyone uses an app-native confirmation modal. Done: the modal explains that the live session ends immediately for everyone, uses danger styling, focuses the safe cancel action first, shows `Ending...` while pending, restores focus after close, and calls the existing manual end flow only after confirmation.~~
- **Done**: ~~Stop all student cameras uses an app-native confirmation modal. Done: the modal explains the bulk moderation effect, uses warning treatment, shows `Stopping cameras...` while pending, and does not emit the moderation command when cancelled.~~
- **Done**: ~~Start server-side recording uses an app-native confirmation modal. Done: the modal explains the recording indicator/retention implication, uses warning treatment, shows `Starting recording...` while pending, and calls the existing recording start flow only after confirmation.~~
- **Done**: ~~Browser-native `confirm()`, `prompt()`, and `alert()` calls are removed from class-session/shared production code. Done: `rg "globalThis.confirm|window.confirm|confirm\\(|globalThis.prompt|window.prompt|prompt\\(|globalThis.alert|window.alert|alert\\(" apps/frontend/src/app/features/class-session apps/frontend/src/app/shared --glob '!**/*.spec.ts'` returns no production matches.~~
- **Done**: ~~The confirmation modal is app-native and accessible. Done: it renders `role="dialog"`, `aria-modal="true"`, title/message labels, cancel/confirm buttons, action-specific pending state, and danger/warning variants.~~
- **Done**: ~~Keyboard and focus handling are wired. Done: `Esc` cancels open confirmation state, Enter confirmation avoids editable input targets, danger modals focus cancel first, and focus returns to the trigger when the modal closes.~~
- **Done**: ~~Class-session chat link attachment no longer uses browser-native `prompt()`. Done: attaching a link opens an app-native link dialog with `role="dialog"`, `aria-modal`, URL validation, `Esc` cancel, focus restore, and mobile-safe styling.~~

Verification:

- Focused teacher class-session spec passed: `npm test --workspace @native-sfu/frontend -- --include=src/app/features/class-session/teacher/class-session.spec.ts` with `TOTAL: 11 SUCCESS`.
- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- Static native-dialog scan passed with no production matches for browser-native `confirm`, `prompt`, or `alert` in class-session/shared code.
- `git diff --check` passed.
- Focused chat spec still has the existing Karma/Chrome ping-timeout blocker before specs execute (`0 of 5`), so chat link-dialog behavior is covered by compile/static verification until that harness issue is resolved.

### P0: Teacher Controls Must Be Organized

Status: **Done** as of 2026-06-25.

Every checklist item below is fully struck through and marked **Done**.

Teacher controls final UX cleanup:

- **Done**: ~~Direct actions live under the teacher 3-dot menu. Done: share screen, share whiteboard, switch/stop active sharing, mute all students, stop student cameras, lock/unlock class, start/stop recording, download attendance, attach board notes, and End for everyone are direct menu actions.~~
- **Done**: ~~Device settings open on demand. Done: camera and microphone selectors stay in the device drawer, including current selected device labels and refresh control.~~
- **Done**: ~~Secondary media/class attention state is available on demand. Done: the status drawer now shows media, network, recording, share source, class lock, student count, live cameras, raised hands, and locally hidden media without duplicating action buttons.~~
- **Done**: ~~Whiteboard drawing toolbar stays focused on board tools. Done: the teacher class-session page no longer renders the End Session control inside the shared whiteboard toolbar.~~

Verification:

- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- Focused teacher class-session spec passed: `npm test --workspace @native-sfu/frontend -- --include=src/app/features/class-session/teacher/class-session.spec.ts`.
- `git diff --check` passed.
- Sandboxed Angular build and Karma test were blocked by local sandbox restrictions (`ng build` exited `134`; Karma could not bind port `9876`), then passed outside the sandbox with Node 22.

### P0: Mobile And Tablet QA

Class-session pages need viewport proof before pilot.

Status: **Pending Proof**. Hardening pass applied on 2026-06-25; real screenshot proof is still pending.

Completed lines are marked **Done**. Remaining evidence gaps are marked **Pending Proof**.

Related QA note:

- `docs/class-session-mobile-tablet-qa.md`

Completed hardening:

- **Done**: ~~Student waiting/error pages use dynamic viewport height and safe-area padding. Done 2026-06-25.~~
- **Done**: ~~Student live controls reserve extra bottom space when media errors or network warnings add rows. Done: this reduces PiP/chat overlap risk on mobile.~~
- **Done**: ~~Student live controls, top actions, drawer close buttons, and media buttons have coarse-pointer tap target hardening. Done.~~
- **Done**: ~~Student materials drawer uses full drawer mode instead of compact sidebar mode. Done.~~
- **Done**: ~~Materials drawer content scrolls internally instead of growing beyond the drawer. Done.~~
- **Done**: ~~Teacher waiting/error pages use dynamic viewport height and safe-area padding. Done.~~
- **Done**: ~~Teacher tablet portrait keeps a larger whiteboard row before the sidebar. Done.~~
- **Done**: ~~Teacher media menu, drawer triggers, device controls, status strip, and participant moderation buttons have coarse-pointer tap target hardening. Done.~~
- **Done**: ~~Teacher class-session shell uses contained touch behavior while preserving whiteboard canvas drawing behavior. Done.~~

Verification completed:

- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed with the repo-supported Node 22 runtime outside the sandbox.~~
- **Done**: ~~Focused teacher class-session spec. Done: `npm test --workspace @native-sfu/frontend -- --include=src/app/features/class-session/teacher/class-session.spec.ts` passed with `TOTAL: 9 SUCCESS`.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

Verification still blocked:

- **Pending Proof**: Focused chat spec: `npm test --workspace @native-sfu/frontend -- --include=src/app/features/class-session/session-chat/session-chat.spec.ts` currently connects ChromeHeadless and then hits a Karma ping timeout before executing specs.
- **Pending Proof**: Real screenshot proof: pending because the current local setup does not provide a seeded authenticated live teacher/student classroom with media producers, chat, materials, and whiteboard-share state.

Target viewports:

- 360x740
- 390x844
- 430x932
- 740x360
- 844x390
- 932x430
- 768x1024
- 820x1180
- 1024x768
- 1180x820

Required checks:

- no overlap between media, PiP, controls, chat, and drawers
- prejoin modals fit
- teacher menus and drawers fit
- whiteboard drawing does not scroll the page accidentally
- chat works with the virtual keyboard
- tap targets are usable
- desktop layout does not regress

Required proof still pending:

- real screenshots for the target viewport matrix
- pass/minor/blocker review for each screenshot state
- authenticated teacher and student route proof from a seeded live class

## Broad Production Blockers

Status: **Blocker** for broad production until these sections are either **Done** or explicitly accepted as release risk.

These should be resolved before broad paid-user rollout.

### P0: Staging Media Networking Proof

Status: **Blocker**.

A green local build does not prove production WebRTC behavior.

Required staging proof:

- public ICE host candidate reachability
- TURN relay behavior with real credentials
- UDP media port exposure for `HOST_CANDIDATE_PORT_RANGE`
- correct `ICE_ANNOUNCED_ADDRESS`
- browser publish/subscribe through real staging ingress
- Socket.IO reconnect behavior over real ingress
- drain and restart behavior
- readiness and metrics behavior under load

Local scale proof harness:

- `npm run docker:start:multi-node`
- `npm run seed:dummy-users:multi-node`
- `npm run test:live-soak:local`

This local harness creates two backend nodes with shared Redis/Mongo and pipe enabled, then writes a JSON report under `reports/live-soak/`. It is useful evidence for backend/socket owner routing, remote publisher/subscriber paths, drain behavior, and cleanup. It does not close this blocker by itself because it does not prove public browser media, TURN, shared ingress, or Kubernetes UDP exposure.

Latest scale/multi-node readiness update:

Status: **Done** for the checked-in local proof harness. **Pending Proof** for an actual passing two-node soak report and real staging signoff.

Completed harness work:

- **Done**: ~~A checked-in local two-node Docker Compose stack exists. Done: `infra/docker-compose.multi-node.yml` starts MongoDB, Redis, backend node A, and backend node B with distinct HTTP, media UDP, and pipe UDP ranges.~~
- **Done**: ~~Local proof scripts are wired from root package scripts. Done: `docker:start:multi-node`, `docker:up:multi-node`, `docker:down:multi-node`, `seed:dummy-users:multi-node`, and `test:live-soak:local` are available.~~
- **Done**: ~~The live-soak harness writes auditable report files. Done: `tests/load/live-soak-signoff.mjs` writes timestamped JSON reports under `reports/live-soak/` unless `REPORT_FILE=stdout` is used.~~
- **Done**: ~~The live-soak harness has explicit pass/fail checks. Done: it fails on cleanup leaks, worker readiness failures, metrics refresh failures, drain new-room admission failures, missing distributed node presence when expected, or unsupported pipe runtime when expected.~~
- **Done**: ~~The docs now separate local backend/socket proof from staging browser/network proof. Done: `docs/testing.md`, `docs/deployment.md`, `docs/pipe-transport.md`, `docs/server-requirements.md`, and `docs/unproven-checklist.md` describe the split.~~

Verification completed for the harness update:

- **Done**: ~~Node syntax check passed. Done: `/Users/webskitters/.nvm/versions/node/v22.22.3/bin/node --check tests/load/live-soak-signoff.mjs`.~~
- **Done**: ~~Docker Compose config renders. Done: `/usr/local/bin/docker compose -f infra/docker-compose.multi-node.yml config`.~~
- **Done**: ~~Backend build passed. Done: `npm run build --workspace @native-sfu/backend`.~~
- **Done**: ~~Frontend build passed. Done: `npm run build --workspace @native-sfu/frontend`.~~
- **Done**: ~~Admin portal build passed. Done: `npm run build --workspace @native-sfu/admin-portal`.~~
- **Done**: ~~Focused cluster/pipe/signal tests passed. Done: `npm test --workspace @native-sfu/backend -- node-registry.service.spec.ts pipe-coordinator.service.spec.ts room-signal.service.spec.ts` with 52 passing tests.~~
- **Done**: ~~Focused room gateway/service tests passed. Done: `npm test --workspace @native-sfu/backend -- rooms.gateway.spec.ts rooms.service.spec.ts` with 164 passing tests.~~
- **Done**: ~~Whitespace check passed. Done: `git diff --check`.~~

Still pending:

- **Pending Proof**: A real local `npm run test:live-soak:local` report is not attached yet. The run was intentionally not started in the latest pass because existing Docker containers already occupied host ports `3000`, `3002`, and `6379`.
- **Pending Proof**: Real staging must still prove public TURN, public ICE candidate reachability, browser publish/subscribe through shared ingress, sticky or owner-aware Socket.IO routing, `HOST_CANDIDATE_PORT_RANGE`, `PIPE_PORT_RANGE`, and rollout drain behavior.
- **Pending Proof**: Active room migration or automatic owner handoff is not implemented; node drain preserves existing rooms and blocks new ownership, but does not migrate active rooms.

Related docs:

- `docs/deployment.md`
- `docs/server-requirements.md`
- `docs/testing.md`
- `docs/unproven-checklist.md`

### P0: Production Security Configuration

Status: **Done** as of 2026-06-25 for repo-side production security configuration verification and hardening.

Environment signoff is still required before broad production: real production secret values, monitoring destinations, backups, and restore procedures must be provisioned and verified in the target environment.

Required checks:

- **Done**: ~~Production secrets are stored outside version control. Done: `infra/k8s/secret.example.yaml` remains placeholder-only and production validation rejects missing/default required secrets.~~
- **Done**: ~~`TURN_SECRET`, JWT secrets, operation tokens, and webhook secrets are unique and rotated. Done: production validation rejects known placeholders, short values, and reused shared-secret values; rotation guidance is documented in `docs/security.md` and `docs/deployment.md`.~~
- **Done**: ~~Swagger is disabled unless explicitly protected. Done: Swagger stays disabled by default in production, and if enabled it requires `X-Operations-Token`.~~
- **Done**: ~~Diagnostics and metrics require operator authorization. Done: `/metrics`, metrics aliases, media diagnostics/control endpoints, and event operator endpoints use the operations-token path; token comparison is timing-safe.~~
- **Done**: ~~CORS and runtime `/env.js` point to real production origins. Done: production CORS validation rejects wildcard, localhost, non-HTTPS, and path/query origins; frontend/admin runtime config defaults to same-origin and ignores accidental localhost overrides on non-local origins.~~
- **Done**: ~~Frontend does not ship localhost API/socket config. Done: frontend and admin runtime environment services now use same-origin defaults instead of baked-in localhost fallbacks for production-style execution.~~
- **Done**: ~~Unauthorized students cannot read, watch, join, chat, or load materials for other batches. Done: existing enrollment-backed class-session, room, chat, and materials authorization regression tests passed after this hardening pass.~~
- **Done**: ~~Class-session lifecycle events cannot be watched by unauthorized users. Done: existing `session:watch` authorization regression tests passed after this hardening pass.~~

Verification run:

- `npm run build --workspace @native-sfu/backend`
- `npm run build --workspace @native-sfu/frontend`
- `npm run build --workspace @native-sfu/admin-portal`
- `npm test --workspace @native-sfu/backend -- env.validation.spec.ts operations-token.guard.spec.ts health.controller.spec.ts metrics.controller.spec.ts`
- `npm test --workspace @native-sfu/backend -- rooms.gateway.spec.ts rooms.service.spec.ts class-sessions.service.spec.ts`
- `npm test --workspace @native-sfu/backend -- media.controller.spec.ts recordings.service.spec.ts platform-events.service.spec.ts`
- `git diff --check`

### P0: Demo Or Static Data Cleanup

Any remaining demo data in student, teacher, enrollment, profile, dashboard, or class-session surfaces must be removed, backend-driven, or explicitly demo-gated.

Status: **Done** as of 2026-06-25 for the frontend portal production surfaces covered by this P0 pass.

Every checklist item below is fully struck through and marked **Done**.

Completed cleanup:

- **Done**: ~~Student enrollment store no longer exposes a hardcoded local catalog. Done: `apps/frontend/src/app/features/student/student-enrollment.store.ts` now loads available and enrolled batches from `/student-enrollments` backend APIs only.~~
- **Done**: ~~LocalStorage enrollment fallback was removed from production flow. Done: legacy `native-sfu-student-enrollments` values no longer create enrolled batches or class-session access state.~~
- **Done**: ~~Hardcoded sample teachers, classes, reviews, awards, gallery items, and demo-class records were removed from the student enrollment store. Done: the old `BATCH_CATALOG`, `TEACHER_PROFILES`, `TeacherDemoClass`, and `demoClasses` source data are gone from production source.~~
- **Done**: ~~Student dashboard uses backend data or honest states. Done: loading, backend error, retry, and no-enrollment states are explicit; fake enrolled batches are not rendered.~~
- **Done**: ~~Student explore uses backend data or honest states. Done: loading, backend error, retry, and no-available-batches states are explicit; fake available classes are not rendered.~~
- **Done**: ~~Profile stylesheet demo naming was removed. Done: stale `demo-card` and `demo-list` selectors were removed from teacher and public-teacher profile styles; both profile surfaces already load backend profile data.~~
- **Done**: ~~Landing page named static testimonials were made generic. Done: visible fake person names were replaced with role-based labels.~~
- **Done**: ~~Class-session surfaces were reviewed for fake live data. Done: participant cards, chat, materials, media, and whiteboard state are driven from session/room/service state; remaining camera/video/prejoin placeholders are state placeholders, not fake users.~~
- **Done**: ~~Admin portal scan did not identify reachable fake user/class/material/analytics data in this pass. Done: remaining hits are filter placeholders and layout CSS such as `position: static`.~~

Verification completed:

- **Done**: ~~Focused frontend store spec. Done: `npm test --workspace @native-sfu/frontend -- --include=src/app/features/student/student-enrollment.store.spec.ts` passed with `TOTAL: 3 SUCCESS`.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed with the repo-supported Node 22 runtime outside the sandbox.~~
- **Done**: ~~Dangerous-term scan. Done: `rg "demo|mock|fake|dummy|BATCH_CATALOG|TEACHER_PROFILES|TeacherDemoClass|demoClasses|native-sfu-student-enrollments|ananya|rahul|mira|dev-demo|WebRTC Foundations|Media Routing Lab|Angular Classroom UI|Scaling SFU" apps/frontend/src/app --glob '!**/*.spec.ts' --glob '!**/*.test.ts'` returned no production matches.~~
- **Done**: ~~Broad scan residue was reviewed. Done: remaining `sample`, `placeholder`, and `static` matches are math sampling variables, form input placeholders, camera-off/prejoin placeholders, and CSS positioning, not production demo data.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

### P1: Public Teacher Profile Gallery And Demo Classes

Status: **Done** for the implemented 2026-07-08 scope.

Every completed checklist item below is fully struck through and marked **Done**. Admin moderation/review workflow remains a later marketplace/promotion expansion, not a blocker for the current gallery/demo baseline.

- **Done**: ~~Teacher-managed public gallery exists. Done: teachers can create, edit, archive, upload media for, publish, and unpublish public gallery items from the teacher profile page.~~
- **Done**: ~~Teacher-managed demo/sample class entries exist. Done: demo class items use the same backend-backed public content workflow and appear separately from gallery items.~~
- **Done**: ~~Public teacher profile shows only published gallery/demo items. Done: public profile response includes published-only `gallery` and `demoClasses` arrays, while draft/unpublished items stay out of the public page.~~
- **Done**: ~~Private enrolled-class artifacts are not reused as public demos by default. Done: gallery/demo items live in a dedicated `teacher_public_contents` collection instead of class-session material, recording, or whiteboard artifact records.~~
- **Done**: ~~Public demo URLs do not expose raw storage keys. Done: uploaded files are served through backend public profile media URLs, and local storage path/key fields are not returned in the public contract.~~
- **Done**: ~~Disabled/private teacher profiles do not expose gallery or demo content. Done: the existing public teacher profile availability check still hides the full public profile unless the teacher is active, enabled, and public-profile enabled.~~

Verification completed:

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Focused profile service tests. Done: `npm test --workspace @native-sfu/backend -- profiles.service.spec.ts` passed with published-only and teacher-management authorization coverage.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

### P1: Teacher Marketplace And Discovery

Status: **Done** for the implemented 2026-07-08 P1 baseline.

Every completed checklist item below is fully struck through and marked **Done**. Paid promotion, rating/price filters, featured placements, and admin editorial ordering remain tracked as marketplace expansion work.

- **Done**: ~~Public teacher marketplace exists. Done: `/teachers` now provides a compact teacher-first discovery page with search/filter controls, teacher cards, pagination/load-more, loading/error/empty states, and links to public teacher profiles.~~
- **Done**: ~~Marketplace API returns only active public teachers. Done: `GET /api/v1/teachers` filters to active, enabled, public-profile-enabled teacher users.~~
- **Done**: ~~Teacher cards expose only safe public fields. Done: cards include avatar, display name, headline, public skills/languages, location/timezone/availability, highlighted credential, active public batch count, next batch start, and published gallery/demo counts; email, phone, settings, storage keys, and private artifacts are excluded.~~
- **Done**: ~~Search and filters work for the P1 data model. Done: the API and UI support query search, skill/topic, subject, language, and availability/open-batch filters.~~
- **Done**: ~~Gallery/demo availability is visible without leaking private class artifacts. Done: counts are derived only from published `teacher_public_contents`, not class-session materials, recordings, chats, attendance, assignments, or whiteboard artifacts.~~
- **Done**: ~~Student Explore and public profile navigation connect to marketplace. Done: student header and batch Explore link to `/teachers`, and public teacher profiles link back to the marketplace while keeping batch Explore/enrollment separate.~~

Verification completed:

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Focused profile service tests. Done: `npm test --workspace @native-sfu/backend -- profiles.service.spec.ts` passed with marketplace privacy/filter coverage.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

### P2: Public Teacher Profile Promotion And Paid Visibility

Status: **Done** for the implemented 2026-07-08 promotion foundation. Payment checkout, impression/click analytics, richer ranking controls, and legal disclosure wording remain tracked future scope.

Completed scope:

- **Done**: ~~Teacher promotion records are separate from public profile publishing. Done: `teacher_promotions` stores lifecycle status, placement, active window, teacher identity snapshot, billing/payment placeholders, request/approval/cancel metadata, admin notes, timestamps, and indexes.~~
- **Done**: ~~Teacher can request promotion without self-activating it. Done: teachers can list and request their own promotions from the frontend profile page, but requests remain admin-review state.~~
- **Done**: ~~Only eligible teachers can be promoted. Done: backend checks require an active, enabled, public-profile-enabled teacher before request/approval can affect visibility.~~
- **Done**: ~~Admin can manage promotion lifecycle. Done: admin portal has a Profile promotions queue with filters and approve, pause, cancel, and reject actions backed by admin-only APIs.~~
- **Done**: ~~Approved in-window promotions affect public marketplace visibility. Done: active promoted teachers are boosted before organic results and cards include promoted placement metadata.~~
- **Done**: ~~Expired, cancelled, rejected, private, disabled, or unpublished profiles do not receive public promotion. Done: marketplace promotion metadata is derived only after the safe public-teacher filter.~~
- **Done**: ~~Promotion events are audit-safe. Done: request/approval/pause/cancel/reject actions write audit entries with safe metadata and no payment secrets or private profile data.~~

Verification completed:

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Focused profile service tests. Done: `npm test --workspace @native-sfu/backend -- profiles.service.spec.ts` passed with promotion request, eligibility, overlap, admin approval, marketplace boost, and expired/cancelled coverage.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Admin portal build. Done: `npm run build --workspace @native-sfu/admin-portal` passed.~~

Tracked follow-ups:

- **Tracked**: Payment checkout/subscription entitlement is not implemented; current `billingStatus` and `paymentReference` fields are placeholders for manual/admin-controlled workflow.
- **Tracked**: Promotion analytics such as impressions, profile clicks, demo opens, inquiries, and enrollment attribution are not implemented yet.
- **Tracked**: Explicit rating/price/popularity filters and numeric editorial priority remain future marketplace data/ranking work.
- **Tracked**: Final sponsored/paid legal disclosure wording should be reviewed before paid campaigns go live.

### P1: Student Post-Class Access And Private Q&A

Status: **Done** for the implemented 2026-07-07 scope.

Every completed checklist item below is fully struck through and marked **Done**. Remaining polish is listed separately as **Tracked**.

Completed scope:

- **Done**: ~~Enrolled students can open completed-session history. Done: student completed-session list/detail routes load backend data for historically enrolled batches only.~~
- **Done**: ~~Completed-session detail is student-safe. Done: the student page aggregates authorized recordings, read-only whiteboard state, shared materials, teacher broadcasts, own attendance, related assignments, and the student's own private teacher thread.~~
- **Done**: ~~Post-class questions are private. Done: student follow-up questions use the teacher-student private chat thread and are never broadcast to the room or other students.~~
- **Done**: ~~Teacher replies are private and session-scoped. Done: teacher batch detail exposes a Post-class Q&A panel with private per-student thread summaries, history, and replies.~~
- **Done**: ~~Post-class Q&A is distinguishable from live private chat. Done: chat messages now support `context: live | post_class`, post-class writes persist `context: post_class`, and post-class history/summary filters use that context.~~
- **Done**: ~~Student1 cannot see Student2's private Q&A. Done: post-class student history resolves only the authenticated student's teacher-student thread key; teacher history validates the selected student against the historical roster.~~
- **Done**: ~~Non-enrolled students cannot access guessed completed-session artifacts. Done: completed detail and Q&A reuse historical enrollment authorization before loading artifacts or chat history.~~
- **Done**: ~~Completed-session material downloads match completed detail authorization. Done: material downloads now use resolution-aware completed-session access so historically enrolled students can download allowed completed-session materials.~~

Verification:

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Focused backend class-session/chat tests. Done: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts rooms.service.spec.ts` passed with 180 tests.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

Tracked follow-ups:

- **Tracked**: Post-class Q&A read-state clearing is not fully completed-session-aware yet; unread counts may require refresh/read-state hardening.
- **Tracked**: Student Q&A does not auto-refresh teacher replies after initial page load.

### P1: Teacher Post-Class Workflow

Status: **Done** for the implemented 2026-07-07 teacher workflow scope.

Every completed checklist item below is fully struck through and marked **Done**. Remaining polish is listed separately as **Tracked**.

Completed scope:

- **Done**: ~~Teacher can open one completed-session workspace for owned sessions. Done: completed session row actions open the post-class workspace from teacher batch detail, backed by `GET /api/v1/class-sessions/:sessionId/post-class-workspace`.~~
- **Done**: ~~Workspace composes recap and operational context. Done: it includes the completed-session report, attendance/participation summaries, broadcasts, materials, recordings, whiteboard notes, private Q&A summaries, and assignments linked to the session.~~
- **Done**: ~~Teacher can mark post-class questions important, answered, or follow-up. Done: Q&A workflow flags persist in `class_session_post_class_thread_states` without copying private message bodies into workflow records.~~
- **Done**: ~~Teacher can publish selected artifacts explicitly. Done: post-class publish/unpublish actions exist for individual materials, recordings, and whiteboard notes.~~
- **Done**: ~~Unpublished artifacts remain hidden from students. Done: student completed-session recording/material/whiteboard list, download, and whiteboard memory access now check explicit post-class publication state.~~
- **Done**: ~~Teacher can create a post-class announcement. Done: the workspace announcement composer writes a post-class broadcast and does not auto-copy private student question content.~~
- **Done**: ~~Teacher can start follow-up homework from completed-session context. Done: the workspace `Create follow-up` action opens the existing assignment form with the completed session preselected.~~
- **Done**: ~~Private student questions are not exposed broadly. Done: broad report/workspace data excludes private Q&A message bodies; private replies remain in the existing teacher-student Q&A thread UI.~~

Verification:

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Focused backend class-session tests. Done: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts` passed with 55 tests.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

Tracked follow-ups:

- **Tracked**: Add a dedicated sanitized "promote selected Q&A into announcement" flow only after copy/privacy review.
- **Tracked**: Add focused frontend unit coverage for the new workspace once batch-detail tests are split into smaller test surfaces.

### P1: Post-Class Report And Recap

Status: **Done** for the implemented 2026-07-07 teacher/admin recap scope.

Every completed checklist item below is fully struck through and marked **Done**. Remaining polish is listed separately as **Tracked**.

Completed scope:

- **Done**: ~~Teacher/admin completed-session report endpoint. Done: `GET /api/v1/class-sessions/:sessionId/report` is available for owning teachers/admins, and `GET /api/v1/admin/class-sessions/:sessionId/report` is available for admins.~~
- **Done**: ~~Report combines session metadata and attendance. Done: the report includes session timing/status, batch/course/teacher metadata, attendance totals, attendance rate, average duration, reconnects, late joins, early leaves, and snapshot/inferred attendance source.~~
- **Done**: ~~Report combines participation and support highlights. Done: participation counts are derived from class-session timeline events, and support/media/moderation incident highlights are included from safe timeline records.~~
- **Done**: ~~Report combines learning artifacts. Done: recording metadata, shared materials, whiteboard snapshot summary, assignments, and assignment submission status totals are included.~~
- **Done**: ~~Report summarizes broadcasts and post-class Q&A without leaking private chat bodies. Done: public teacher broadcast count/latest preview is included, while private Q&A appears only as thread/activity/unanswered/unread counts.~~
- **Done**: ~~Teacher UI can open the report. Done: teacher batch detail completed-session actions now open the post-class workspace, which includes the compact report panel plus artifact publishing, announcements, Q&A triage, and assignment shortcut.~~
- **Done**: ~~Admin UI can inspect the report. Done: admin class-session detail loads the recap and shows attendance, artifact, participation, assignment, and Q&A cards.~~
- **Done**: ~~Report remains available after room closure. Done: the report reads persisted completed-session, attendance, artifact, assignment, timeline, and chat metadata rather than active room state.~~
- **Done**: ~~Teacher/admin can export the completed-session report. Done: CSV exports are available from `GET /api/v1/class-sessions/:sessionId/report/export.csv` and `GET /api/v1/admin/class-sessions/:sessionId/report/export.csv`, and they reuse the safe `ClassSessionReport` data without private Q&A/chat bodies.~~
- **Done**: ~~Teacher/admin can print the completed-session report. Done: teacher batch detail and admin class-session detail include Print actions with report-focused print styles.~~

Verification:

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Admin portal build. Done: `npm run build --workspace @native-sfu/admin-portal` passed.~~
- **Done**: ~~Focused backend report tests. Done: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts` passed with 55 tests, including CSV export/privacy checks.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

Tracked follow-ups:

- **Tracked**: Report currently shows aggregate assignment/Q&A status; per-student drilldowns should stay behind explicit privacy-reviewed UI.
- **Tracked**: Student-facing completed-session detail remains separate and student-safe; no broad student report was added in this pass.

### P1: Search And Library

Status: **Done** for the implemented 2026-07-07 metadata-search scope.

Every completed checklist item below is fully struck through and marked **Done**. Remaining expansion is listed separately as **Tracked**.

Completed scope:

- **Done**: ~~Shared class-library contract. Done: `packages/contracts/src/class-library.ts` defines artifact types, result metadata, filters, pagination, and summary response types shared by backend, frontend, and admin portal.~~
- **Done**: ~~Student search is enrollment-protected. Done: `GET /api/v1/class-library/search` scopes student results to historically enrolled batches, completed sessions, and student-visible published/shared artifacts.~~
- **Done**: ~~Teacher search is ownership-protected. Done: teacher results are limited to batches owned by the authenticated teacher.~~
- **Done**: ~~Admin search is admin-only. Done: `GET /api/v1/admin/class-library/search` is protected for admin/super-admin users and can search platform artifact metadata.~~
- **Done**: ~~Search covers learning artifacts without adding a parallel search system. Done: results include sessions, recordings, materials, whiteboard pages, assignments, teacher announcements, and Q&A status metadata from existing collections.~~
- **Done**: ~~Search filters are wired. Done: course, batch, teacher, date range, artifact type, status, page, and limit filters are supported by the shared query contract.~~
- **Done**: ~~Private and sensitive fields are excluded. Done: private chat/Q&A bodies, assignment submission bodies, raw storage keys, and raw file paths are not returned in broad library search results.~~
- **Done**: ~~Frontend library page exists. Done: `/class-library` is available in the frontend portal and linked from student and teacher dashboards.~~
- **Done**: ~~Admin library page exists. Done: `/class-library` is available in the admin portal and linked from the admin sidebar.~~

Verification:

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Focused backend class-library tests. Done: `npm test --workspace @native-sfu/backend -- class-library.service.spec.ts` passed with 4 tests.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Admin portal build. Done: `npm run build --workspace @native-sfu/admin-portal` passed.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

Tracked follow-ups:

- **Tracked**: Add richer full-text ranking or a dedicated search index only if metadata search becomes insufficient at production scale.
- **Tracked**: Keep private Q&A body search limited to explicit authorized teacher-student thread views, not broad library search.
- **Tracked**: Add richer lookup selectors for course/batch/teacher filters if admins need friendlier discovery than raw ids.

### P1: Student Progress Dashboard

Status: **Done** for the implemented 2026-07-08 student self-progress baseline.

Every completed checklist item below is fully struck through and marked **Done**. Remaining expansion is listed separately as **Tracked**.

Completed scope:

- **Done**: ~~Backend-backed student progress page for the authenticated student only. Done: `/student/progress` calls `GET /api/v1/class-sessions/student/progress`, and the backend derives the student id from auth.~~
- **Done**: ~~Progress summary should reuse enrollment, completed-session history, attendance snapshots, assignments, recordings, private Q&A metadata, and participation/timeline source records. Done: the service aggregates from those existing sources without a parallel analytics store.~~
- **Done**: ~~Values should cover attendance rate/trend, completed/missed/upcoming classes, assignment due/submitted/reviewed/overdue counts, recording review state where tracking exists, and participation/Q&A status where records exist. Done: the response includes those counts, with recording watch progress marked unavailable because per-student watch tracking is not persisted yet.~~
- **Done**: ~~Empty states must be honest when recording-watch, attendance, assignment, or participation data is unavailable. Done: availability notes are returned for attendance, assignments, recordings, participation, and Q&A.~~
- **Done**: ~~The view must not expose class-wide analytics, other-student progress, private Q&A bodies, private chat bodies, assignment submission bodies, raw storage keys, or raw media data. Done: focused backend tests verify peer/private data is absent.~~
- **Done**: ~~Mobile/tablet layout should be compact and usable in the frontend portal. Done: the progress page uses responsive summary cards, batch panels, and mobile-collapsed grids.~~

Acceptance proof:

- **Done**: ~~Student can load only their own progress. Done: endpoint scope is the authenticated student, and no arbitrary student id is accepted.~~
- **Done**: ~~Non-students or unauthorized users cannot load student progress unless a separate admin analytics flow explicitly allows it. Done: the route is student-only and tests reject a teacher user.~~
- **Done**: ~~Student cannot request another student's progress. Done: there is no `studentId` query/body field for this endpoint.~~
- **Done**: ~~Attendance, assignment, recording, and participation counts match existing source records. Done: the focused service test covers snapshot attendance, student assignment submission, published recording readiness, and student-only activity events.~~
- **Done**: ~~Private Q&A/chat bodies are not included in summary payloads. Done: progress returns Q&A counts/workflow metadata only.~~
- **Done**: ~~Frontend progress page builds and shows honest loading, error, and empty states. Done: frontend build passed and the page includes loading/error/empty views.~~

Verification:

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Focused backend tests. Done: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts` passed.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~
- **Pending Proof**: Frontend Karma test runner still has a local ChromeHeadless disconnect before specs execute, even though the build passed.

Tracked follow-ups:

- **Done**: ~~Persist per-student recording watch/progress events before showing watched/unwatched analytics. Done 2026-07-08: `recording_playback_progress` now stores authorized student progress, and student progress reports watched/unwatched, watched time, and completion rate from persisted playback progress.~~
- **Done**: ~~Add subject/weak-topic recommendations only after deterministic tagged learning-outcome data exists. Done 2026-07-08: student progress now returns source-linked deterministic recommendations, including existing whiteboard page tag review signals where tags are available. Richer subject taxonomy remains tracked as future content-model work.~~

### P1: Teacher Analytics

Status: **Done** for the implemented 2026-07-08 teacher/admin analytics scope.

Every completed checklist item below is fully struck through and marked **Done**. Remaining expansion is listed separately as **Tracked**.

Completed scope:

- **Done**: ~~Shared teacher analytics contract. Done: `packages/contracts/src/teacher-analytics.ts` defines query filters, availability states, summary cards, per-batch rollups, per-student risk indicators, and privacy-safe source identifiers.~~
- **Done**: ~~Teacher-owned analytics API. Done: `GET /api/v1/teacher/analytics` returns analytics only for batches owned by the authenticated teacher.~~
- **Done**: ~~Admin analytics alias. Done: `GET /api/v1/admin/teacher-analytics` lets admin/super-admin users query cross-batch analytics without giving students access.~~
- **Done**: ~~Attendance and engagement aggregation. Done: analytics reuse attendance snapshots or inferred attendance plus class-session activity/timeline records for attendance rate, missed classes, reconnects, joins, hand raises, and allowed-speaking turns.~~
- **Done**: ~~Assignment aggregation. Done: analytics include due, submitted, reviewed, overdue, missing/no-submission, and source assignment ids where safe.~~
- **Done**: ~~Q&A and participation aggregation. Done: private Q&A thread state contributes question counts and unanswered status without exposing private message bodies.~~
- **Done**: ~~Recording and material usage metadata. Done: recording readiness metadata, persisted playback progress, watched/not-watched counts, average completion, total watch time, material download events, and weak-topic/review signals are reported without private message bodies or raw storage data.~~
- **Done**: ~~Conservative risk indicators. Done: repeated absences, missing/no submissions, low recorded participation, and unanswered Q&A generate explainable count-based risk labels.~~
- **Done**: ~~Frontend teacher analytics page. Done: `/teacher/analytics` provides filters, summary cards, per-batch insights, risk indicators, and source links from the frontend portal.~~
- **Done**: ~~Privacy controls. Done: analytics exclude private chat/Q&A bodies, assignment submission bodies, raw storage keys, raw attachment URLs, and raw media payloads.~~

Verification:

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Admin portal build. Done: `npm run build --workspace @native-sfu/admin-portal` passed.~~
- **Done**: ~~Focused backend class-session tests. Done: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts` passed with 59 tests.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

Tracked follow-ups:

- **Done**: ~~Persist normalized recording playback/watch telemetry before reporting per-student recording completion or watch-time analytics. Done 2026-07-08: teacher analytics now uses persisted recording playback progress for watched/not-watched, average completion, and total watch time.~~
- **Tracked**: Add an admin portal visual teacher-analytics page if admins need a UI beyond the admin API alias.
- **Done**: ~~Add richer topic, weak-area, and concept analytics only after questions, assignments, or whiteboard artifacts carry reliable tags. Done 2026-07-08: teacher analytics now exposes batch weak-topic/review signals from deterministic counts and existing whiteboard page tags. Richer concept taxonomy remains future scope.~~

### P1: Student Support And Escalation

Status: **Done** for the implemented 2026-07-08 student/admin support scope.

Every completed checklist item below is fully struck through and marked **Done**. Remaining expansion is listed separately as **Tracked**.

Completed scope:

- **Done**: ~~Shared support contracts. Done: `packages/contracts/src/support.ts` defines issue types, statuses, safe diagnostics, request/comment payloads, list query, and admin update request contracts.~~
- **Done**: ~~Support request persistence. Done: `class_session_support_requests` stores student-owned support tickets with batch/session/room/recording context, status, safe diagnostics, admin responses, and timestamps.~~
- **Done**: ~~Student support API. Done: `POST /api/v1/support/requests`, `GET /api/v1/support/requests`, and `GET /api/v1/support/requests/:requestId` are student-authenticated and own-ticket scoped.~~
- **Done**: ~~Admin support queue API. Done: `GET /api/v1/admin/support-requests`, `GET /api/v1/admin/support-requests/:requestId`, and `PATCH /api/v1/admin/support-requests/:requestId` support admin triage and status updates.~~
- **Done**: ~~Enrollment-protected class context. Done: class/session/recording-linked support requests resolve their batch and require the student to be historically enrolled before persistence.~~
- **Done**: ~~Student support UI. Done: `/student/support` lets students submit support requests, include safe diagnostics, and see their own request status updates.~~
- **Done**: ~~Contextual student entry points. Done: dashboard, live class, completed class, and completed-class recording rows link into support with useful prefilled context.~~
- **Done**: ~~Admin support UI. Done: `/support` in the admin portal shows a compact shared-table support queue with filters, triage detail, status update, student-visible response, and internal-note controls.~~
- **Done**: ~~Privacy-safe diagnostics. Done: support stores only explicit support messages, safe IDs, userAgent/route/timestamp/platform/permission state, and redacts token-like route parameters.~~
- **Done**: ~~Audit/timeline integration. Done: support request creation writes audit records and actor-only class-session support timeline events when a session context exists.~~

Verification:

- **Done**: ~~Contracts build. Done: `npm run build --workspace @native-sfu/contracts` passed.~~
- **Done**: ~~Focused backend support tests. Done: `npm test --workspace @native-sfu/backend -- support.service.spec.ts` passed with 4 tests.~~
- **Done**: ~~Backend build. Done: `npm run build --workspace @native-sfu/backend` passed.~~
- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed.~~
- **Done**: ~~Admin portal build. Done: `npm run build --workspace @native-sfu/admin-portal` passed.~~
- **Done**: ~~Whitespace check. Done: `git diff --check` passed.~~

Tracked follow-ups:

- **Tracked**: Add teacher-owned class-related support visibility after product rules define whether teachers can respond, view read-only, or remain excluded from support tickets.
- **Tracked**: Add richer support assignment to real admin/support users if the product adds a support-role roster beyond admin/super-admin.
- **Tracked**: Add notification delivery for support status changes once support notification rules are finalized.

### P1: Whiteboard Production Teaching UX

Status: **Done** for the listed production-teaching checklist.

The whiteboard is capable. The 2026-06-25 teaching-quality pass completed the main interaction polish below; keep this section as a regression checklist.

Priority items:

- **Done**: ~~keep drawing tools in the existing left vertical toolbar if that is the current product direction. Done/preserved.~~
- **Done**: ~~add a clear More or Math menu. Done/preserved.~~
- **Done**: ~~open Math tools in a draggable popover. Done/preserved.~~
- **Done**: ~~support equation, templates, and snippets first. Done: equation update flow, expanded snippets, and editable starter templates are wired.~~
- **Done**: ~~make eraser behavior production-grade, not only element-wise deletion. Done: partial, stroke, and area eraser modes are available.~~
- **Done**: ~~add a production pen dropdown with premium writing styles. Done 2026-07-06: the Pen tool has its own dropdown for solid, dashed, dotted, marker, pencil, and calligraphy strokes, plus stroke width, opacity, smoothing, prompt-aligned `penStyle` / `pressureEnabled` stroke metadata, pressure-sensitive input where supported, and a style-aware brush preview.~~
- **Done**: ~~add Pen Auto Close controls for near-closed loops. Done 2026-07-06: Pen settings include an Auto close toggle, Tight/Normal/Loose sensitivity, helper text, explicit closed/open state for new strokes, and a canvas snap preview when the current stroke is close enough to close.~~
- **Done**: ~~add Presentation / Teach Mode for focused live instruction. Done 2026-07-06: the whiteboard menu enters a local presentation mode that hides the full toolbar, keeps compact page controls visible, emphasizes the laser pointer, offers quick pen/highlighter actions with an edit toggle, exits with Escape, and preserves the existing canvas whiteboard sharing path.~~
- **Done**: ~~make closed-shape fill and fill-color updates reliable. Done: selected style sync lets teachers update fill/stroke color after selection; existing closed-stroke fill detection is preserved.~~
- **Done**: ~~add color picker beyond predefined colors. Done: custom color input and recent colors are available for stroke, fill, and equation color.~~
- **Done**: ~~preserve undo/redo, delete, escape deselect, zoom, copy/paste/duplicate shortcuts. Done/preserved, with arrow-key nudging added.~~

Verification:

- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed for the pen dropdown, Pen Auto Close, and Presentation Mode pass.~~

### P1: Whiteboard Math-Friendly Templates

Status: **Done**.

The 2026-06-25 Phase 2 pass completed the math-friendly structure work below; keep this section as a regression checklist.

Priority items:

- **Done**: ~~grid background. Done as a per-page background template.~~
- **Done**: ~~graph-paper background. Done as a per-page background template.~~
- **Done**: ~~ruled notebook background. Done as a per-page background template.~~
- **Done**: ~~geometry construction background. Done as a per-page background template.~~
- **Done**: ~~coordinate axes template. Done as both a page background and movable board object.~~
- **Done**: ~~number line template. Done as both a page background and movable board object.~~
- **Done**: ~~table layout template. Done as both a page background and movable board object.~~
- **Done**: ~~fraction bar template. Done as both a page background and movable board object.~~
- **Done**: ~~multiple board pages. Done with add, switch, rename, duplicate, and delete controls.~~
- **Done**: ~~page tabs. Done with compact page tabs.~~
- **Done**: ~~export current page as image. Done through current-page PNG export.~~
- **Done**: ~~export full board as PDF. Done through all-pages PDF export.~~

### P1: Whiteboard Math Text And Equation Blocks

The 2026-06-25 Phase 3 pass completed the academic notation workflow below; keep this section as a regression checklist.

Status: **Done**. Every checklist item below is fully struck through, so the Done note is part of the completed item.

Priority items:

- **Done**: ~~equation blocks. Done: equation elements are selectable, movable, resizable, duplicable, deletable, undoable, exportable, and synced through the existing whiteboard command path.~~
- **Done**: ~~LaTeX-style input. Done: Math tools includes a LaTeX-style editor, live canvas preview, Insert/Update action, selected-equation editing, and visible validation errors.~~
- **Done**: ~~shortcut palette. Done: grouped shortcuts insert fractions, powers, subscripts, square roots, Greek letters, integrals, summations, limits, vectors, angles, and 2 x 2 / 3 x 3 matrices at the cursor.~~
- **Done**: ~~inline labels. Done: text labels preserve bounds, color, fill, font size, and left/center/right alignment.~~
- **Done**: ~~convert text to equation. Done: selected text labels can become rendered equations while preserving position, approximate size, color, fill, alignment, and undo support.~~
- **Done**: ~~equation alignment. Done: context menu actions support text alignment, selected-object left/center/right alignment, and vertical distribution.~~
- **Done**: ~~keyboard safety while editing. Done: global board shortcuts do not fire while text or equation inputs are focused.~~

### P1: Whiteboard Matrix And Table Editor

The 2026-07-06 matrix/table pass completed the editable structured-content workflow below; keep this section as a regression checklist.

Status: **Done**. Every checklist item below is fully struck through, so the Done note is part of the completed item.

Priority items:

- **Done**: ~~canvas-native matrix objects. Done: matrix elements are selectable, movable, resizable, duplicable, deletable, undoable, exportable, persistable, and synced through the existing whiteboard command path.~~
- **Done**: ~~canvas-native table objects. Done: table elements support editable cells, rows, columns, header row state, borders, fills, colors, alignment, and existing object transforms.~~
- **Done**: ~~common matrix presets. Done: 2 x 2, 3 x 3, row vector, column vector, augmented matrix, and determinant presets are available in Math tools.~~
- **Done**: ~~cell editing workflow. Done: the Matrix/Table Math tools panel supports direct cell editing, dimensions, text size, colors, border visibility, fill, bracket style, augmented-column selection, Insert, and Update.~~
- **Done**: ~~selected object edit flow. Done: double-click and context-menu edit load an existing matrix/table back into the editor.~~
- **Done**: ~~export and sharing compatibility. Done: matrix/table objects render on canvas, so they appear in PNG/PDF export and whiteboard-as-video sharing.~~
- **Done**: ~~student whiteboard-control compatibility. Done: granted students can create/edit matrix/table objects under annotate/current-page-edit permissions while unauthorized students stay blocked.~~

Verification:

- Contracts build passed: `npm run build --workspace @native-sfu/contracts`.
- Frontend build passed: `npm run build --workspace @native-sfu/frontend`.
- `git diff --check` passed.

Intentional limits:

- Cell editing is panel-based rather than inline-cell editing on the canvas.
- Hybrid PDF export can emit matrix/table content as vector/text primitives, but exported content remains a whiteboard object representation rather than selectable spreadsheet cells.

### P1: Whiteboard Graphing And Visualization

The 2026-06-25 Phase 4 pass completed the graphing and visualization workflow below; keep this section as a regression checklist.

Status: **Done**. Every checklist item below is fully struck through, so the Done note is part of the completed item.

Priority items:

- **Done**: ~~safe function plotting. Done: graph expressions use the existing bounded safe parser, not `eval` or `new Function`, and support multiple function entries.~~
- **Done**: ~~editable graph objects. Done: graph objects remain selectable, draggable, resizable, duplicable, deletable, editable, undoable, exportable, and synced through the existing whiteboard command path.~~
- **Done**: ~~viewport and axes controls. Done: x/y bounds, grid, axes, ticks, and custom tick spacing are editable.~~
- **Done**: ~~calculus helpers. Done: helper points, tangent lines, shaded area intervals, intercept markers, and multiple function/line curves are supported.~~
- **Done**: ~~inequality shading. Done: simple `y > f(x)`, `y <= f(x)`, and `x >= c` style regions render with transparent fill and inclusive/exclusive boundary styling.~~
- **Done**: ~~parametric and polar plots. Done: bounded `x(t)` / `y(t)` and `r(theta)` plots render through the safe parser.~~
- **Done**: ~~statistics plots. Done: scatter plots, regression lines with R2, histograms, and normal curves are supported.~~
- **Done**: ~~annotations. Done: coordinate labels can be added inside graph objects, while existing text/equation labels remain movable board annotations.~~
- **Done**: ~~export and sharing compatibility. Done: all graph layers render on canvas, so they are included in image/PDF export and whiteboard-as-video sharing.~~

Verification:

- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- `git diff --check` passed.
- Sandboxed Angular build still exits with the known local `134` abort after starting `ng build`; the elevated Node 22 build is the verified result.

Intentional Phase 4 limits:

- Inequality shading is a safe first pass for simple classroom forms: `y > f(x)`, `y <= f(x)`, and `x >= c` / `x <= c`.
- Graph annotations are coordinate labels inside graph objects; separately movable labels remain normal text/equation board elements.
- Statistics plots are intended for lightweight classroom explanation, not full data import or analytics.

### P1: Whiteboard Geometry And Diagram Tools

The 2026-06-25 Phase 5 pass completed the geometry and diagram workflow below; keep this section as a regression checklist.

Status: **Done**. Every checklist item below is fully struck through, so the Done note is part of the completed item.

Priority items:

- **Done**: ~~ruler / straightedge. Done: the existing straightedge segment tool is preserved, and a saved ruler geometry aid now renders tick marks, length labels, and endpoint handles.~~
- **Done**: ~~protractor. Done: a protractor geometry aid renders a semicircle, degree ticks, labels, and a radius baseline for classroom angle work.~~
- **Done**: ~~compass-style circle construction. Done/preserved: the existing circle geometry tool remains selectable, fillable, measurable, movable, undoable, exportable, and synced through the whiteboard command path.~~
- **Done**: ~~angle measurement. Done/preserved: the angle geometry tool continues to render measured angle arcs and labels when measurements are enabled.~~
- **Done**: ~~snap-to-point and snap-to-grid. Done: grid snap is preserved, and a separate point-snap toggle now snaps to endpoints, midpoints, shape bounds, circle cardinal points, and polygon vertices.~~
- **Done**: ~~vector arrows. Done/preserved: vector geometry arrows remain available through Math tools and the existing canvas-native geometry flow.~~
- **Done**: ~~polygon tools. Done: a regular polygon geometry tool now creates a canvas-native regular hexagon with fill/stroke support, selection bounds, endpoint markers, and snap vertices.~~
- **Done**: ~~parallel/perpendicular helpers. Done/preserved: the existing construction helpers remain available through the grouped Geometry tools.~~
- **Done**: ~~Venn diagram tool. Done/preserved: the editable Venn starter remains available as a movable diagram object.~~
- **Done**: ~~graph theory node/edge tool. Done/preserved: the editable node-edge starter remains available as a movable diagram object.~~
- **Done**: ~~tree diagram tool. Done/preserved: the editable tree and probability-tree starters remain available as movable diagram objects.~~

Verification:

- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- Sandboxed Angular build still exits with the known local `134` abort after starting `ng build`; the elevated Node 22 build is the verified result.

Intentional Phase 5 limits:

- The polygon tool is a regular hexagon first pass; triangle, square, pentagon, and arbitrary polygon presets can be added later without changing the command model.
- Ruler and protractor are saved canvas geometry aids, not temporary floating overlays.
- Node-edge and tree tools remain editable starter diagrams, not a full graph-layout editor.

### P1: Whiteboard Lesson Assets And Annotation

The 2026-06-25 Phase 6 pass completed lesson asset import, annotation, and board-note attachment below; keep this section as a regression checklist.

Status: **Done**. Every checklist item below is fully struck through, so the Done note is part of the completed item.

Priority items:

- **Done**: ~~PDF import. Done: PDF files render client-side through the existing pdf.js path into ordered annotatable whiteboard pages, with size and page-count limits plus password/corrupt-file errors.~~
- **Done**: ~~image import. Done: PNG, JPEG, and WebP files can be imported as movable image objects or as non-selectable page backgrounds.~~
- **Done**: ~~slide-image import. Done: exported slide images can be multi-selected and imported in order as separate annotatable pages; PPT/PPTX files now have a guarded import entry that validates type/size and directs teachers to the conversion-backed PDF/image import path when conversion is not configured.~~
- **Done**: ~~annotation over imported pages. Done: imported PDF/image/slide pages render as page backgrounds, while pen, eraser, text, equations, graphs, geometry, diagrams, and images remain editable elements above them.~~
- **Done**: ~~material page navigation. Done/preserved: imported pages use the existing page tabs/navigation and active-page whiteboard-as-video capture.~~
- **Done**: ~~blank page interleaving. Done: teachers can add blank pages before or after the current page, plus the existing add-at-end flow.~~
- **Done**: ~~annotated lesson export. Done: all whiteboard pages export as PDF, with Hybrid PDF mode emitting supported text/vector annotations where feasible and keeping raster fallback for imported assets, complex content, and failures.~~
- **Done**: ~~attach exported board notes. Done: teacher can attach generated board-note PDFs through the existing class-session materials upload/share flow so authorized students receive them in the materials panel.~~

Verification:

- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- Sandboxed Angular/esbuild build still exits with the known local `134` deadlock after starting `ng build`; the elevated Node 22 build is the verified result.

Intentional Phase 6 limits:

- Native PPT/PPTX slide conversion is not implemented in-browser; the PPT/PPTX menu path validates files and clearly directs teachers to PDF-page or slide-image import until a server conversion service is configured.
- Hybrid PDF export is partial by design: text, strokes, shapes, geometry basics, matrices, and tables can be emitted as PDF text/vector primitives; imported raster assets, imported PDF pages, complex equations, graphs, diagrams, and failures stay on the reliable raster fallback.
- Imported page/background mutations are local whiteboard page state; students see them through whiteboard-as-video and attached notes, while element annotations keep the existing command path.
- Remote image URLs are not imported directly, avoiding cross-origin canvas tainting; selected local files and server-downloaded materials remain the safe path.

### P1: Whiteboard Advanced Import/Export Polish

The 2026-07-06 import/export pass added guarded deck-import UX and hybrid PDF output quality improvements; keep this section as a regression checklist.

Status: **Done** for implemented scope. Every completed checklist item below is fully struck through, so the Done note is part of the completed item.

Priority items:

- **Done**: ~~PPT/PPTX import entry. Done: the whiteboard menu exposes Import PPT/PPTX deck.~~
- **Done**: ~~presentation validation. Done: PPT/PPTX files are type/extension checked and capped at 50 MB before conversion guidance is shown.~~
- **Done**: ~~safe conversion behavior. Done: since there is no repo-native PPT renderer or backend conversion pipeline yet, the UI does not attempt unreliable browser conversion and instead guides teachers to import PDF pages or exported slide images.~~
- **Done**: ~~PDF export mode selector. Done: teachers can choose Hybrid PDF or Fast raster PDF from the whiteboard menu.~~
- **Done**: ~~hybrid PDF vector/text primitives. Done: text, strokes, basic shapes/arrows, geometry basics, matrices, and tables can export as PDF primitives where feasible.~~
- **Done**: ~~raster fallback. Done: imported assets, imported PDF pages, slide-image backgrounds, complex equations, graphs, diagrams, and failures remain covered by exact raster PDF output.~~

Verification:

- Frontend build passed: `npm run build --workspace @native-sfu/frontend`.
- `git diff --check` passed.

Intentional limits:

- Native deck-to-slide conversion remains future work and should be server-backed, not browser-only.
- Hybrid PDF does not embed custom fonts and is intentionally partial.
- Large converted decks must stay capped because current whiteboard memory stores imported backgrounds as data URLs.

### P1: Whiteboard Academic Session Memory

The 2026-06-25 Phase 8 pass added persisted academic board memory. The 2026-07-07 persisted realtime pass extended it from snapshot-only memory to operation-backed sync for late joins, refreshes, and completed-session review. Keep this section as a regression checklist for live teaching continuity and reusable lesson records.

Status: **Done** for implemented scope. Every completed checklist item below is fully struck through, so the Done note is part of the completed item. Unstruck items remain intentional future work.

Priority items:

- **Done**: ~~persist board state per class session. Done: session-scoped whiteboard memory stores bounded schema-versioned snapshots plus accepted realtime operation records with operation ids, sequence metadata, and current-state cursor fields.~~
- **Done**: ~~resume board after teacher reconnect or page reload. Done: teacher live classroom loads saved board memory and debounced autosave keeps recoverable state current.~~
- **Done**: ~~load board state for late joins and student refreshes. Done: live students load the authorized saved board into a read-only board drawer and apply realtime whiteboard command updates.~~
- **Done**: ~~show completed-session whiteboard read-only. Done: completed class detail loads the final saved board for authorized historical students without enabling edit tools.~~
- **Done**: ~~restore board from a previous session in the same batch. Done: teacher can list previous batch boards and restore one into the current live board.~~
- **Done**: ~~manual checkpoints and version history. Done: teacher checkpoints create bounded whiteboard versions and can be restored.~~
- **Done**: ~~page title and tag metadata. Done: whiteboard pages can be titled/tagged, and backend search queries saved page titles/tags.~~
- **Done**: ~~export class notes PDF. Done/preserved: current all-pages board PDF export remains available from the whiteboard menu.~~
- **Done**: ~~attach notes to class materials. Done/preserved: generated board-note PDFs can be attached and shared through the existing class-session materials flow.~~
- **Done**: ~~selected-page export picker. Done: the whiteboard menu includes a compact page picker and exports selected pages in board order as a PDF.~~
- **Done**: ~~prompt-compatible API aliases. Done: `POST /class-sessions/:sessionId/whiteboard/restore-previous` and `GET /class-sessions/:sessionId/whiteboard/search` are available alongside the existing whiteboard memory endpoints.~~
- AI summary/extraction. Future: intentionally not implemented; Phase 8 uses no AI calls.

Verification:

- Contracts build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/contracts`.
- Backend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/backend`.
- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- Focused backend class-session spec passed: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts`.
- `git diff --check` passed.
- Sandboxed Angular/esbuild build still exits with the known local `134` abort after starting `ng build`; the elevated Node 22 build is the verified result.

Intentional Phase 8 limits:

- Whiteboard memory now stores accepted live operations for sync/idempotency and keeps bounded snapshots/checkpoints as the compact read model; it still does not expose a full collaborative CRDT, branching history, or user-facing per-step replay UI.
- Search is title/tag based for saved pages; deeper full-text note search remains future work.
- Students can read authorized saved board state through class-session access rules, but teacher/admin owns mutation and restore operations.

### P1: Subject-Specific Whiteboard Templates

Status: **Done** for implemented scope. Every completed checklist item below is fully struck through, so the Done note is part of the completed item.

Priority items:

- **Done**: ~~Subject Templates entry. Done: the teacher whiteboard menu opens the Subject Templates tab inside Math tools.~~
- **Done**: ~~Subject categories. Done: algebra, calculus, geometry, physics, chemistry, economics, coding/CS, probability, statistics, and accounting categories are available.~~
- **Done**: ~~Template search. Done: teachers can filter the selected subject category by template name, description, or tags.~~
- **Done**: ~~New-page insertion. Done: subject templates can create a new tagged board page with the correct page background and generated canvas-native elements.~~
- **Done**: ~~Current-page insertion. Done: subject templates can apply their page template and append guide elements without deleting existing annotations.~~
- **Done**: ~~Movable-object insertion. Done: subject templates can be inserted as grouped text, shape, table, graph, and diagram elements for normal move/duplicate/delete workflows.~~
- **Done**: ~~Export, memory, and sharing compatibility. Done: templates use existing whiteboard elements, so PNG/PDF export, saved whiteboard memory, checkpoints, restore, and whiteboard-as-video sharing continue on the existing paths.~~

Verification:

- **Done**: ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed for the subject template pass.~~

### P1: Observability, Audit, And Operator Runbooks

Status: **Done**.

The 2026-06-25 P1 observability pass completed the signals and operator runbooks below. Completed items are fully struck through; if a line contains a Done note, the Done note is part of the completed item.

Required production signals:

- **Done**: ~~session started and ended. Done: lifecycle audit and `sfu_class_session_lifecycle_transitions_total` metrics are wired.~~
- **Done**: ~~teacher disconnected and reconnected. Done: teacher connection audit records are wired for disconnect/reconnect during reconnect grace.~~
- **Done**: ~~reconnect grace timer started, cancelled, or expired. Done: reconnect grace audit records, event counters, and active timer gauge are wired.~~
- **Done**: ~~student join denied or admitted. Done: HTTP class-session join and socket room join both record safe audit entries and bounded join metrics.~~
- **Done**: ~~media publish/consume failures. Done: class-session publish/consume failure metrics and safe audit records are wired without media payloads.~~
- **Done**: ~~chat send/read failures. Done: class-session chat send/read failure metrics and safe audit records are wired without raw message bodies.~~
- **Done**: ~~recording start/stop/failure. Done/preserved through existing recording audit and platform events.~~
- **Done**: ~~moderation actions. Done: student media moderation audit and bounded action metrics are wired.~~
- **Done**: ~~whiteboard control grants/revokes. Done: whiteboard control grant/revoke audit and bounded action metrics are wired.~~
- **Done**: ~~material share/upload/download events. Done: material upload/link/share/unshare/download/delete audit and metrics are wired without file contents or private URLs.~~

Required runbooks:

- **Done**: ~~stuck live session. Done in `docs/operator-runbook.md`.~~
- **Done**: ~~teacher cannot publish media. Done in `docs/operator-runbook.md`.~~
- **Done**: ~~students cannot consume media. Done in `docs/operator-runbook.md`.~~
- **Done**: ~~TURN relay failure. Done in `docs/operator-runbook.md`.~~
- **Done**: ~~recording failed. Done in `docs/operator-runbook.md`.~~
- **Done**: ~~chat delivery issue. Done in `docs/operator-runbook.md`.~~
- **Done**: ~~unauthorized access report. Done in `docs/operator-runbook.md`.~~
- **Done**: ~~Mongo/Redis degraded. Done in `docs/operator-runbook.md`.~~

### P2: Production Observability And Support Tooling

Status: **Done** for the implemented 2026-07-09 admin health and support tooling scope.

Completed items are fully struck through; if a line contains a Done note, the Done note is part of the completed item.

- **Done**: ~~Admin/operator session health view. Done: admin class-session detail now shows an Operational Health panel backed by `GET /api/v1/admin/class-sessions/:sessionId/health`.~~
- **Done**: ~~Support-safe health payload. Done: the health endpoint returns safe session, room, teacher connection, participant count, media count, join denial, recording, support, issue, and admin-link summaries without private bodies, storage keys, tokens, or raw media payloads.~~
- **Done**: ~~Dashboard operational issue surfacing. Done: the admin dashboard now surfaces teacher reconnecting, recent media failures, recent class join denials, failed recordings, and unresolved support requests as issue cards.~~
- **Done**: ~~Support and recording metrics. Done: `sfu_class_session_support_requests_total` and `sfu_class_session_recording_events_total` are emitted alongside the existing lifecycle, reconnect, join, media, chat, moderation, whiteboard, and material metrics.~~
- **Done**: ~~Support diagnostics remain privacy-safe. Done: support requests store explicit student support text plus bounded diagnostics only, with route token redaction and no private chat/Q&A bodies or raw attachment URLs.~~
- **Done**: ~~Operator runbook describes the support-health workflow. Done: `docs/operator-runbook.md` now documents the session health snapshot endpoint and safe-data boundary.~~

Verification:

- Contracts build passed: `npm run build --workspace @native-sfu/contracts`.
- Backend build passed: `npm run build --workspace @native-sfu/backend`.
- Frontend build passed: `npm run build --workspace @native-sfu/frontend`.
- Admin portal build passed: `npm run build --workspace @native-sfu/admin-portal`.
- Focused backend tests passed: `npm test --workspace @native-sfu/backend -- admin-dashboard.service.spec.ts support.service.spec.ts class-sessions.service.spec.ts rooms.service.spec.ts recordings.service.spec.ts metrics.service.spec.ts`.
- `git diff --check` passed.
- Dev runtime signoff remains under the P0 build/runtime blocker until backend, frontend, admin portal, API, and socket smoke checks are run together.

### P1: Backups, Retention, And Data Lifecycle

Status: **Blocker** for broad production.

Verify:

- Mongo backup and restore plan
- recording retention and expiry behavior
- chat attachment retention
- attendance snapshot retention
- audit log retention
- user/profile/avatar file retention
- safe deletion or archival behavior for batches, sessions, materials, and recordings

## Scale And Multi-Node Gaps

Status: **Blocker** for large-scale or multi-node production.

These should block a large-scale rollout, but may not block a small single-node pilot if risks are accepted.

### P1: Multi-Node Ownership And Pipe Proof

Status: **Blocker** for multi-node production.

Required proof:

- owner routing works across nodes
- reconnect lands on the correct owner or redirects safely
- pipe transport behavior is validated when enabled
- node drain does not strand sessions
- cross-node private/targeted socket events remain correct
- no private chat or moderation leakage across rooms/nodes

Related docs:

- `docs/pipe-transport.md`
- `docs/mediasoup-gap-roadmap.md`
- `docs/unproven-checklist.md`

### P1: Soak And Load Testing

Status: **Blocker** for broad scale.

Required proof:

- long-running class sessions on the actual server class
- multiple concurrent live classes
- room join/leave churn
- media publish/consume churn
- network degradation and recovery
- Redis/Mongo behavior under expected write volume
- memory/CPU/worker health over time

### P2: Cross-Browser Confidence

Status: **Pending Proof**.

Required coverage:

- Chrome/Chromium
- Firefox
- WebKit/Safari
- iOS Safari device permission behavior
- Android Chrome camera/mic behavior
- autoplay and `playsinline` behavior

## Recommended Fix Order

1. **Blocker**: Make build and dev runtime verification green in the normal development environment.
2. **Blocker**: Capture real teacher/student class-session screenshots from the running app.
3. **Done**: ~~Replace native confirms with app-native confirmation modals. Done 2026-06-25; class-session/shared code also no longer uses browser-native prompt/alert in production paths.~~
4. **Done**: ~~Finish teacher 3-dot menu, device drawer, and class controls drawer. Done 2026-06-25.~~
5. **Pending Proof**: Run mobile/tablet QA and fix layout overlaps. Hardening applied 2026-06-25; real screenshot proof still pending.
6. **Blocker**: Prove teacher camera/screen/whiteboard media rendering in student UI.
7. **Pending Proof**: Prove PDF/image/slide-image whiteboard import, annotation, export, and attached board notes in a real browser.
8. **Done**: ~~Clean up or backend-drive remaining demo/static frontend data. Done 2026-06-25 for frontend portal production surfaces; student enrollment/dashboard/explore now backend-drive data or show honest empty/error states.~~
9. **Blocker**: Run staging media proof for TURN, UDP, ingress, publish/subscribe, reconnect, and drain.
10. **Partially Done**: Production security configuration hardening is done 2026-06-25; real environment secret provisioning, monitoring destination checks, backups, and restore proof remain broad-production signoff items.
11. **Tracked**: Run a small controlled pilot and log every incident before broad rollout.

## Acceptance Checklist Before Controlled Pilot

- Backend build passes.
- Frontend build passes.
- Admin portal build passes.
- Backend dev mode starts and health/API/socket basics respond.
- Frontend dev mode starts and teacher/student class-session pages load.
- Admin portal dev mode starts and dashboard/module pages load.
- Teacher can start a scheduled class manually.
- Enrolled student can join only after teacher starts.
- Non-enrolled student cannot read, watch, join, chat, load materials, or open media.
- Teacher camera is visible to students.
- Teacher screen share is visible to students.
- Teacher whiteboard share is visible to students.
- Teacher camera PiP works while screen or whiteboard is shared.
- Teacher can import a PDF or exported slide image into the whiteboard, annotate over it, and export annotated notes.
- Teacher can attach exported board notes to class materials, and enrolled students can access only authorized notes.
- Teacher can grant one enrolled student whiteboard control, lock the board, keep/clear tracked student changes, and save the attempt as class notes.
- Teacher can end session manually.
- Teacher disconnect grace works.
- Student sees reconnecting state, then ended state only when backend ends the class.
- Private chat does not leak between students.
- Teacher broadcast is explicit and clearly labeled.
- Teacher moderation controls work and are role-gated.
- Teacher class controls work.
- Mobile/tablet class-session pages are usable.
- No native browser confirm remains for destructive teacher actions.
- Real screenshots are attached to the QA signoff.

## Acceptance Checklist Before Broad Production

- Staging TURN proof passes.
- Staging browser publish/subscribe proof passes.
- Public UDP media path is proven.
- Drain/restart behavior is proven.
- Multi-node behavior is proven if multi-node rollout is planned.
- Repo-side production secret and operation-token validation is done; deployed secret provisioning still needs environment signoff.
- Swagger/diagnostics/metrics exposure is reviewed and protected.
- Monitoring and alerting are active.
- Backups and restore have been tested.
- Recording, attachment, attendance, and audit retention policies are configured.
- Cross-browser smoke checks pass.
- Pilot incidents have been reviewed and resolved or accepted.
