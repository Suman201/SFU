# Class Session Production Readiness Gaps

Updated: 2026-06-25

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
- Selective student whiteboard control and whiteboard command events.
- Admin modules for attendance, recordings, enrollments, users, courses, batches, dashboard, and audit-style operational surfaces.

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

### P1: Whiteboard Production Teaching UX

Status: **Done** for the listed production-teaching checklist.

The whiteboard is capable. The 2026-06-25 teaching-quality pass completed the main interaction polish below; keep this section as a regression checklist.

Priority items:

- **Done**: ~~keep drawing tools in the existing left vertical toolbar if that is the current product direction. Done/preserved.~~
- **Done**: ~~add a clear More or Math menu. Done/preserved.~~
- **Done**: ~~open Math tools in a draggable popover. Done/preserved.~~
- **Done**: ~~support equation, templates, and snippets first. Done: equation update flow, expanded snippets, and editable starter templates are wired.~~
- **Done**: ~~make eraser behavior production-grade, not only element-wise deletion. Done: partial, stroke, and area eraser modes are available.~~
- **Done**: ~~make closed-shape fill and fill-color updates reliable. Done: selected style sync lets teachers update fill/stroke color after selection; existing closed-stroke fill detection is preserved.~~
- **Done**: ~~add color picker beyond predefined colors. Done: custom color input and recent colors are available for stroke, fill, and equation color.~~
- **Done**: ~~preserve undo/redo, delete, escape deselect, zoom, copy/paste/duplicate shortcuts. Done/preserved, with arrow-key nudging added.~~

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
- **Done**: ~~slide-image import. Done: exported slide images can be multi-selected and imported in order as separate annotatable pages; native PPT/PPTX parsing remains intentionally out of scope.~~
- **Done**: ~~annotation over imported pages. Done: imported PDF/image/slide pages render as page backgrounds, while pen, eraser, text, equations, graphs, geometry, diagrams, and images remain editable elements above them.~~
- **Done**: ~~material page navigation. Done/preserved: imported pages use the existing page tabs/navigation and active-page whiteboard-as-video capture.~~
- **Done**: ~~blank page interleaving. Done: teachers can add blank pages before or after the current page, plus the existing add-at-end flow.~~
- **Done**: ~~annotated lesson export. Done: all whiteboard pages export as a raster PDF including imported page backgrounds, blank pages, templates, annotations, equations, graphs, geometry, and diagrams.~~
- **Done**: ~~attach exported board notes. Done: teacher can attach generated board-note PDFs through the existing class-session materials upload/share flow so authorized students receive them in the materials panel.~~

Verification:

- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- Sandboxed Angular/esbuild build still exits with the known local `134` deadlock after starting `ng build`; the elevated Node 22 build is the verified result.

Intentional Phase 6 limits:

- Native PPT/PPTX parsing is not implemented; teachers should import exported slide images.
- Exported whiteboard PDFs are raster page snapshots, not selectable/vector PDF text.
- Imported page/background mutations are local whiteboard page state; students see them through whiteboard-as-video and attached notes, while element annotations keep the existing command path.
- Remote image URLs are not imported directly, avoiding cross-origin canvas tainting; selected local files and server-downloaded materials remain the safe path.

### P1: Whiteboard Academic Session Memory

The 2026-06-25 Phase 8 pass added persisted academic board memory. Keep this section as a regression checklist for live teaching continuity and reusable lesson records.

Status: **Done** for implemented scope. Every completed checklist item below is fully struck through, so the Done note is part of the completed item. Unstruck items remain intentional future work.

Priority items:

- **Done**: ~~persist board state per class session. Done: session-scoped whiteboard memory stores bounded schema-versioned board snapshots with page metadata.~~
- **Done**: ~~resume board after teacher reconnect or page reload. Done: teacher live classroom loads saved board memory and debounced autosave keeps recoverable state current.~~
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

- Whiteboard memory stores bounded full-board snapshots/checkpoints, not a durable per-operation edit log.
- Search is title/tag based for saved pages; deeper full-text note search remains future work.
- Students can read authorized saved board state through class-session access rules, but teacher/admin owns mutation and restore operations.

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
