# Whiteboard Teacher Experience Enhancement Roadmap

## Purpose

This document captures how much the live class-session whiteboard can still improve from a teacher's perspective.

The current whiteboard foundation is already strong: teachers can draw, annotate, use math tools, import lesson assets, share the board as video, grant controlled student participation, export notes, and persist board memory. The remaining opportunity is mostly about making the board feel faster, more teacher-native, and more polished for real classroom delivery.

## Implementation Status — 2026-10-27

This roadmap distinguishes implemented tools from remaining product work. Earlier readiness percentages were estimates, not release validation.

The shared whiteboard already includes pen styles, opacity, smoothing, stylus pressure, auto-close previews, editable matrices/tables, subject templates, page tags, previous-board restore, and raster/hybrid PDF export. Native PowerPoint conversion remains unavailable; teachers should export decks to PDF or slide images before importing.

Reliability work covers guarded snapshot saves, synchronized page/history changes, fresh student board state, and laser visibility in canvas sharing. Regression coverage should include two connected boards, delayed saves, imported page backgrounds, read-only controls, and captured laser frames. Real classroom validation across target browsers, networks, and touch/stylus devices is still required.

## Highest-Impact Enhancements

### 1. Premium Pen System

Status: implemented; continue device and handwriting-quality validation.

- Dedicated, keyboard-accessible pen settings control.
- Solid, dashed, dotted, marker, pencil, and calligraphy styles.
- Width, opacity, smoothing, supported stylus pressure, and auto-close controls.
- Auto-close sensitivity and visual close preview.

Remaining work: validate handwriting feel and palm/touch behavior on the tablets used by teachers.

### 2. Editable Matrix and Table Editor

Status: implemented; continue classroom workflow validation.

- Canvas-native editable matrix/table objects with row, column, and cell controls.
- Matrix/vector presets and table styling.
- Move, resize, duplicate, delete, history, export, and session-memory support.

Remaining work: validate larger academic examples, keyboard cell navigation, and export fidelity.

### 3. Lesson Preparation and Reuse

Priority: P1

Current gap:

- Whiteboard memory exists, but teacher planning/reuse can become more structured.

Recommended features:

- Prepare board pages before class.
- Save board as reusable lesson template.
- Duplicate a lesson board across batches.
- Expand existing previous-board restore into selective page reuse.
- Extend existing page tags into reusable lesson organization.
- Pin today's agenda.
- Create lesson sections:
  - warm-up
  - concept
  - example
  - practice
  - homework

Teacher value:

- Reduces class setup time.
- Helps teachers reuse high-quality material.
- Makes recurring batches easier to manage.

### 4. Classroom Flow Controls

Priority: P1

Current gap:

- Whiteboard is powerful, but teacher-led pacing can improve.

Recommended features:

- Focus students on current page.
- Hide/reveal next page.
- Reveal solution step-by-step.
- Spotlight a selected board area.
- Spotlight a student attempt.
- Clear only student annotations.
- Save student attempt as a separate page.
- Timer for student whiteboard turn.

Teacher value:

- Better pacing.
- Better student attention.
- More classroom control during live problem solving.

### 5. Advanced Import and Export Polish

Priority: P1

Current gap:

- Native PPT/PPTX import is not implemented.
- Raster and hybrid PDF modes exist; complex math/font fidelity still needs validation.

Remaining work:

- Native PPT/PPTX import through a safe conversion-backed flow.
- Preserve slide ordering, progress feedback, and clear errors in any future converter.
- Verify text selection, shapes, graphs, and raster backgrounds across existing hybrid PDF exports.

Teacher value:

- Easier lesson-material import.
- Cleaner notes export.
- Better post-class artifacts for students.

### 6. Student Participation Polish

Priority: P1

Current gap:

- Selective student control exists, but teacher management can become more classroom-friendly.

Recommended features:

- Queue whiteboard turns.
- Grant control with duration.
- Auto-revoke after timer.
- Compare teacher solution vs student attempt.
- Keep/clear student work per turn.
- Show student cursor/name clearly.
- Save attempt as class note or separate page.

Teacher value:

- More controlled participation.
- Less chaos during live problem solving.
- Better assessment and correction flow.

### 7. Subject-Specific Templates

Priority: P2

Recommended templates:

- Algebra solving layout.
- Calculus derivative/integral layout.
- Geometry construction layout.
- Probability tree layout.
- Statistics chart/table layout.
- Physics free-body diagram layout.
- Chemistry reaction/equation layout.
- Accounting ledger/table layout.
- Coding/flowchart layout.

Teacher value:

- Teachers start faster.
- Board feels built for education, not just drawing.

### 8. Search, Notes, and AI-Assisted Learning Artifacts

Priority: P2

Current gap:

- Page title/tag search exists.
- Deeper full-text note search and AI summary are future work.

Recommended features:

- Search text/equations inside board pages.
- Extract key formulas.
- Generate class summary.
- Generate homework questions.
- Generate solved-problem index.
- Generate topic tags automatically.
- Student-facing notes package:
  - board PDF
  - formulas
  - solved examples
  - homework

Teacher value:

- Better after-class value.
- Less manual note preparation.
- Stronger learning continuity.

### 9. Presentation Mode

Priority: P2

Recommended features:

- Full-stage board mode.
- Collapse toolbars while teaching.
- Bigger laser pointer.
- Clean page navigation.
- Quick reveal/hide controls.
- Teacher-only tool UI hidden from student capture where appropriate.

Teacher value:

- Cleaner student viewing experience.
- Better for recorded classes and large screens.

## Recommended Build Order

### P0: Immediate Teacher UX Gains

1. Premium pen dropdown.
2. Pen auto-close controls.
3. Editable matrix/table editor.

### P1: Classroom Productivity

1. Lesson preparation and reuse.
2. Classroom flow controls.
3. Student participation polish.
4. PPT/PPTX import and improved PDF export.

### P2: Differentiation and Intelligence

1. Subject-specific templates.
2. Presentation mode.
3. Full-text search.
4. AI summary, formula extraction, and homework generation.
5. Deeper whiteboard participation analytics.

## Acceptance Direction

The teacher whiteboard should feel like a live academic teaching workspace, not only a drawing canvas.

Success means:

- Teachers write naturally.
- Teachers prepare lessons faster.
- Teachers teach structured math/science/business topics cleanly.
- Students can participate without disrupting the class.
- Class notes become reusable learning material.
- The board remains compatible with existing whiteboard-as-video sharing, session memory, materials, recording, and controlled student access.


## Real Classroom Acceptance

The browser acceptance suite runs separate teacher/student Chromium contexts against the actual local NestJS API, Socket.IO gateway, MongoDB, Redis and in-process SFU. Camera/microphone inputs are synthetic; classroom requests and media forwarding are real. Component/unit regressions are separate from this acceptance coverage.

Coverage includes drawing and editing tool families, permission modes and student attempts, rendered student ink, teacher/student reconnect, checkpoints and previous-class restore, a 30-page/1,500-stroke board, imports/exports, presentation, static whiteboard video with a fresh receiver, and desktop/phone viewport checks. This does not replace hardware touch/stylus testing, a teacher usability study, cross-browser validation, staging network tests or a classroom load/soak test.

Run from the repository root after installing dependencies and building the backend and workspace packages. Use an isolated local database: the fixture rejects any database name other than `whiteboard_acceptance` on localhost. Ports 3340, 4440 and the fixture UDP range must be free. The suite creates temporary material storage and removes it after each stack stops.

```sh
docker run --rm -d --name whiteboard-test-mongo -p 127.0.0.1:27028:27017 --tmpfs /data/db mongo:7 --bind_ip_all
docker run --rm -d --name whiteboard-test-redis -p 127.0.0.1:16389:6379 redis:7-alpine --save '' --appendonly no

MONGODB_URI=mongodb://127.0.0.1:27028/whiteboard_acceptance \
REDIS_URL=redis://127.0.0.1:16389 \
JWT_ACCESS_SECRET=local-whiteboard-access-secret-only-0001 \
JWT_REFRESH_SECRET=local-whiteboard-refresh-secret-only-0001 \
npm run test:browser -- tests/browser/whiteboard-classroom-acceptance.spec.ts tests/browser/whiteboard-media-acceptance.spec.ts --project=chromium --workers=1

docker stop whiteboard-test-mongo whiteboard-test-redis
```

The secret values above are disposable local-test examples. Keep the two browser specifications sequential because they use the same local ports. Each run records board state, visible canvas evidence, media frame delivery, screenshots and failures under the configured Playwright output directory.
