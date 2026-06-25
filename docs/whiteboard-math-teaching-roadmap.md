# Whiteboard Math Teaching Roadmap

## Purpose

The current whiteboard is useful as a general live-class teaching surface: teachers can draw, explain, annotate, and share the board as video during a class session. For serious school, college, and graduation-level math teaching, the whiteboard should evolve into a math-aware academic workspace.

This roadmap phases that evolution without replacing the existing whiteboard-as-video flow.

## Current Capability

The current whiteboard direction supports:

- Freehand drawing and writing.
- Pen, production eraser modes, custom colors, fill controls, and shape-oriented workflows.
- Teacher-led use during live class.
- Whiteboard-as-video sharing through the existing media path.
- Teacher camera PiP while the board is shared.
- Controlled selective student whiteboard control for participation.
- Persisted academic session memory with autosave, checkpoints, previous-session restore, and page title/tag search.
- Recording visibility because the board is shared as a media stream.
- Multi-page board structure, page templates, image export, and PDF export.
- Math tools for equations, snippets, graphing, statistics, geometry aids, and starter diagrams.
- Geometry and diagram tools including ruler, protractor, compass-style circles, angle measurement, point/grid snapping, vectors, polygon, Venn, node-edge, and tree starters.
- Lesson asset import for PDFs, images, exported slide images, annotation over imported pages, blank-page interleaving, and annotated notes attachment through class materials.

This is now enough for a strong math-teaching pilot. The remaining roadmap is focused on deeper participation hardening, richer lesson-note workflows, and analytics.

## Core Product Goal

The whiteboard should become a flexible teaching canvas that supports both:

- Natural thinking: freehand writing, quick sketches, corrections, annotations.
- Structured math work: equations, graphs, geometry, proofs, pages, exports, and reusable lesson assets.

## Phase 1: Production Teaching Board

Goal: Make the current board feel reliable and premium for daily classes.

Status note, 2026-06-25: the core Phase 1 teaching-quality pass has been implemented in the shared whiteboard. Completed items are fully struck through below.

Scope:

- ~~Better eraser behavior, including stroke-level and partial erase modes. Done: added partial, stroke, and area eraser modes with eraser-size controls and cursor radius preview.~~
- ~~Closed-shape fill and editable fill color. Done: selected element styles now sync into the fill/stroke controls so fill color can be updated after selection; existing closed-shape fill behavior remains intact.~~
- ~~Full color picker, not only predefined colors. Done: custom color input is wired for stroke, fill, and equation color, with recent custom colors for the current board session.~~
- ~~Marquee multi-select. Already in place and preserved.~~
- ~~Keyboard shortcuts: Done/preserved, with arrow-key nudge added for selected elements.~~
  - ~~Delete~~
  - ~~Undo / redo~~
  - ~~Zoom in / zoom out~~
  - ~~Escape to deselect~~
  - ~~Copy / paste / duplicate~~
  - ~~Arrow-key nudge, with Shift for larger movement~~
- ~~Context menu actions: Already in place from the existing whiteboard interaction model and preserved.~~
  - ~~Remove~~
  - ~~Bring forward / send backward~~
  - ~~Flip horizontal / flip vertical~~
- ~~Layer ordering behavior. Already in place through context-menu ordering actions and preserved.~~
- ~~Better closed-shape detection for nearly closed loops. Already in place in the current closed-stroke fill path and preserved.~~
- ~~Stable zoom, pan, and selection behavior. Improved: selected element style sync and keyboard nudging were added without changing existing zoom/pan behavior.~~
- ~~Equation workflow polish. Done: selecting an existing equation now loads it into the Math popover and updates it instead of always inserting a new element.~~
- ~~Math snippets and editable starter templates. Done: added more common math snippets plus editable Venn, flowchart, tree, and probability-tree starters.~~

Outcome:

Teachers can confidently use the board as a polished general whiteboard for school-level and coaching-style classes.

## Phase 2: Math-Friendly Templates

Goal: Add teaching structure without requiring advanced math input.

Status note, 2026-06-25: Phase 2 math-friendly templates are implemented in the shared whiteboard. Completed items are fully struck through below.

Scope:

- ~~Grid background. Done as a per-page background template.~~
- ~~Graph-paper background. Done as a per-page background template.~~
- ~~Ruled notebook background. Done as a per-page background template.~~
- ~~Coordinate axes template. Done as both a page background and movable board object.~~
- ~~Number line template. Done as both a page background and movable board object.~~
- ~~Geometry construction background. Done as a per-page background template.~~
- ~~Table layout template. Done as both a page background and movable board object.~~
- ~~Fraction bar template. Done as both a page background and movable board object.~~
- ~~Multiple board pages. Done with add, switch, rename, duplicate, and delete controls.~~
- ~~Page thumbnails or page tabs. Done with compact page tabs.~~
- ~~Export board page as image. Done through current-page PNG export.~~
- ~~Export full board as PDF. Done through all-pages PDF export.~~

Outcome:

Math teachers can teach arithmetic, algebra, coordinate geometry, and basic statistics with a board that feels intentionally built for education.

## Phase 3: Math Text and Equation Blocks

Status: Complete as of 2026-06-25.

Goal: Support clean academic notation while preserving freehand flow.

How to read this section: every item below is fully struck through, which means the whole line is complete, including the Done note after it.

Scope:

- ~~Insert equation block. Done: equation elements are selectable, movable, resizable, duplicable, deletable, undoable, exportable, and synced through the existing whiteboard command path.~~
- ~~LaTeX-style math input. Done: Math tools includes a LaTeX-style equation editor with live canvas preview, Insert/Update action, safe focus handling, and validation for brace/environment errors.~~
- ~~Editable rendered equations. Done: selected equations load back into the editor from the Math tools popover or double-click edit flow.~~
- ~~Common math shortcuts. Done: grouped shortcut buttons insert fractions, powers, subscripts, square roots, Greek letters, integrals, summations, limits, vectors, angles, and 2 x 2 / 3 x 3 matrices at the cursor.~~
- ~~Inline text and math labels. Done: text labels support preserved bounds, color, fill, font size, and left/center/right alignment, and can be converted into equation labels.~~
- ~~Equation duplication and alignment. Done: existing duplicate/copy/delete behavior is preserved, and the context menu now supports text alignment, object left/center/right alignment, and vertical distribution.~~
- ~~Convert typed math to rendered math. Done: selecting a text label and choosing Convert to equation replaces it with a rendered equation while preserving position, approximate size, color, fill, alignment, and undo support.~~

Outcome:

Teachers can present clean algebra, calculus, linear algebra, and proof notation without struggling with freehand precision. The implementation remains canvas-native, so rendered equations appear in board export, PDF export, whiteboard-as-video sharing, and selective student whiteboard command sync.

## Phase 4: Graphing and Visualization

Status: Complete as of 2026-06-25.

Goal: Make the board useful for higher math and science-style explanation.

How to read this section: every item below is fully struck through, which means the whole line is complete, including the Done note after it.

Scope:

- ~~Plot function from equation. Done: graph expressions are parsed with the existing safe math parser and rendered as canvas function plots, including multiple newline/semicolon-separated functions.~~
- ~~Editable 2D graph object. Done: graph elements remain selectable, draggable, resizable, duplicable, deletable, editable, undoable, exportable, and synced through the existing whiteboard command path.~~
- ~~Axes, scale, tick, and grid controls. Done: the graph editor supports x/y bounds, grid, axes, tick labels, and optional custom tick spacing.~~
- ~~Point, line, curve, tangent, and area tools. Done: the graph editor supports helper point x-values, tangent x-values, shaded area intervals, multiple function/line entries, and curve rendering.~~
- ~~Inequality region shading. Done: simple classroom inequalities such as `y > x + 2`, `y <= x^2`, and `x >= 0` render transparent shaded regions with solid/dashed boundaries.~~
- ~~Parametric curve support. Done: graph objects support `x(t)`, `y(t)`, and bounded t ranges using the same safe expression parser.~~
- ~~Basic polar graph support. Done: graph objects support `r(theta)` with bounded theta ranges and canvas rendering.~~
- ~~Moveable labels and annotations. Done: coordinate labels can be added inside graph objects, and existing text/equation labels remain separately movable board objects.~~
- ~~Simple statistics plots. Done: histogram data, scatter plots, regression lines with R2, and normal curves are supported in the graph editor.~~

Outcome:

Graduation-level teachers can explain calculus, coordinate geometry, probability, statistics, and applied math visually. The implementation remains canvas-native, so graph visualizations appear in board export, PDF export, and whiteboard-as-video sharing.

Verification:

- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- `git diff --check` passed.
- Sandboxed Angular build still exits with the known local `134` abort after starting `ng build`; the elevated Node 22 build is the verified result.

Intentional Phase 4 limits:

- Inequality shading supports simple classroom forms only: `y > f(x)`, `y <= f(x)`, and `x >= c` / `x <= c`.
- Graph annotations are coordinate labels inside the graph object; separately movable labels are still handled by the existing text/equation board elements.
- Statistics are lightweight classroom visualizations, not a full data-analysis/import workflow.

## Phase 5: Geometry and Diagram Tools

Status: Complete as of 2026-06-25.

Goal: Add precision tools for geometry, vectors, and diagram-heavy subjects.

How to read this section: every item below is fully struck through, which means the whole line is complete, including the Done note after it.

Scope:

- ~~Ruler / straightedge. Done: the existing straightedge segment tool is preserved, and a saved ruler geometry aid now renders tick marks, length labels, and endpoint handles.~~
- ~~Protractor. Done: a protractor geometry aid renders a semicircle, degree ticks, labels, and a radius baseline for classroom angle work.~~
- ~~Compass-style circle construction. Done/preserved: the existing circle geometry tool remains selectable, fillable, measurable, movable, undoable, exportable, and synced through the whiteboard command path.~~
- ~~Angle measurement. Done/preserved: the angle geometry tool continues to render measured angle arcs and labels when measurements are enabled.~~
- ~~Snap-to-point and snap-to-grid. Done: grid snap is preserved, and a separate point-snap toggle now snaps to endpoints, midpoints, shape bounds, circle cardinal points, and polygon vertices.~~
- ~~Vector arrows. Done/preserved: vector geometry arrows remain available through Math tools and the existing canvas-native geometry flow.~~
- ~~Polygon tools. Done: a regular polygon geometry tool now creates a canvas-native regular hexagon with fill/stroke support, selection bounds, endpoint markers, and snap vertices.~~
- ~~Parallel/perpendicular helpers. Done/preserved: the existing construction helpers remain available through the grouped Geometry tools.~~
- ~~Venn diagram tool. Done/preserved: the editable Venn starter remains available as a movable diagram object.~~
- ~~Graph theory node/edge tool. Done/preserved: the editable node-edge starter remains available as a movable diagram object.~~
- ~~Tree diagram tool. Done/preserved: the editable tree and probability-tree starters remain available as movable diagram objects.~~

Outcome:

Teachers can build accurate diagrams for geometry, vectors, graph theory, discrete math, and probability.

Verification:

- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- Sandboxed Angular build still exits with the known local `134` abort after starting `ng build`; the elevated Node 22 build is the verified result.

Intentional Phase 5 limits:

- The polygon tool is a regular hexagon first pass; triangle, square, pentagon, and arbitrary polygon presets can be added later without changing the command model.
- Ruler and protractor are saved canvas geometry aids, not temporary floating overlays.
- Node-edge and tree tools remain editable starter diagrams, not a full graph-layout editor.

## Phase 6: Lesson Assets and Annotation

Status: Complete as of 2026-06-25.

Goal: Let teachers teach from prepared materials while keeping whiteboard freedom.

How to read this section: every item below is fully struck through, which means the whole line is complete, including the Done note after it.

Scope:

- ~~Import PDF. Done: PDF files render client-side through the existing pdf.js path into ordered annotatable whiteboard pages, with size and page-count limits plus password/corrupt-file errors.~~
- ~~Import image. Done: PNG, JPEG, and WebP files can be imported as movable image objects or as non-selectable page backgrounds.~~
- ~~Import slide deck or exported slide images. Done: exported slide images can be multi-selected and imported in order as separate annotatable pages; native PPT/PPTX parsing remains intentionally out of scope.~~
- ~~Annotate over imported pages. Done: imported PDF/image/slide pages render as page backgrounds, while pen, eraser, text, equations, graphs, geometry, diagrams, and images remain editable elements above them.~~
- ~~Move between material pages. Done/preserved: imported pages use the existing page tabs/navigation and active-page whiteboard-as-video capture.~~
- ~~Add blank whiteboard pages between imported pages. Done: teachers can add blank pages before or after the current page, plus the existing add-at-end flow.~~
- ~~Save annotated lesson output. Done: all whiteboard pages export as a raster PDF including imported page backgrounds, blank pages, templates, annotations, equations, graphs, geometry, and diagrams.~~
- ~~Attach exported board notes to the class session. Done: teacher can attach generated board-note PDFs through the existing class-session materials upload/share flow so authorized students receive them in the materials panel.~~

Outcome:

Teachers can combine prepared notes, slides, textbook screenshots, and live explanation in one classroom workflow.

Verification:

- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- Sandboxed Angular/esbuild build still exits with the known local `134` deadlock after starting `ng build`; the elevated Node 22 build is the verified result.

Intentional Phase 6 limits:

- Native PPT/PPTX parsing is not implemented; teachers should import exported slide images.
- Exported whiteboard PDFs are raster page snapshots, not selectable/vector PDF text.
- Imported page/background mutations are local whiteboard page state; students see them through whiteboard-as-video and attached notes, while element annotations keep the existing command path.
- Remote image URLs are not imported directly, avoiding cross-origin canvas tainting; selected local files and server-downloaded materials remain the safe path.

## Phase 7: Interactive Student Participation

Status: complete as of 2026-06-25.

~~Goal: Make the board collaborative in a controlled classroom-safe way. Done: selective student participation now uses the existing live class socket/room authorization and whiteboard command stream.~~

Scope:

- ~~Teacher grants whiteboard control to one student. Done: teacher participant cards can grant one enrolled/admitted student whiteboard control.~~
- ~~Teacher revokes control. Done: revoke is available from the active whiteboard turn panel and previous control is revoked when moving to another student.~~
- ~~Student can draw/write only while allowed. Done: student tools are enabled only after grant and backend rejects unauthorized commands.~~
- ~~Teacher sees student cursor. Done: cursor events target the teacher/moderator view and expire after inactivity.~~
- ~~Other students remain view-only. Done: editing tools are only shown to the granted student; other students continue watching the shared whiteboard video.~~
- ~~Teacher can lock board. Done: added `whiteboard:set-lock` / `whiteboard:lock-changed`; lock blocks student commands and cursors while teacher/co-host edits remain allowed.~~
- ~~Teacher can clear student changes or keep them. Done: the teacher tracks the current student turn's new element IDs and can keep or clear only those identifiable student-authored elements.~~
- ~~Student attempts and solutions can be saved as part of class notes. Done: attempts can be exported through the existing whiteboard PDF/materials flow and shared as class notes.~~

Outcome:

~~The board supports solving, participation, viva-style explanation, and teacher-guided correction without becoming chaotic. Done: student participation is teacher-granted, lockable, targeted, and reversible without replacing whiteboard-as-video sharing.~~

Notes:

- Clear attempt is intentionally conservative: it removes only new student-authored elements identified during the active turn and does not delete pre-existing teacher elements.
- Attempt tracking is live client state for the current turn; Phase 8 now persists full-board snapshots/checkpoints, while per-operation durable edit history remains future work.

## Phase 8: Academic Session Memory

Status: Implemented as of 2026-06-25.

Goal: Turn whiteboard work into reusable learning material.

How to read this section: every completed item below is fully struck through, including the Done note. Items not struck through remain intentionally future or partial.

Scope:

- ~~Persist board state per class session. Done: added session-scoped whiteboard memory documents with bounded schema-versioned snapshots and page metadata.~~
- ~~Resume board after reconnect. Done: teacher live classroom loads saved board memory and debounced autosave keeps the session board recoverable.~~
- ~~Restore board from previous session. Done: teacher can list previous boards in the same batch and restore one into the current live board.~~
- ~~Version history. Done: teacher checkpoints create bounded whiteboard versions and can restore saved checkpoints.~~
- ~~Export selected pages. Done: the whiteboard menu includes a compact page picker and exports selected pages in board order as a PDF.~~
- ~~Export class notes PDF. Done/preserved: all-pages board PDF export remains available from the whiteboard menu.~~
- ~~Attach notes to batch/session materials. Done/preserved: teacher can attach generated board-note PDFs through the existing class-session materials flow.~~
- ~~Search board pages by title or tags. Done: pages can be titled/tagged in the whiteboard and backend page search queries saved title/tag metadata.~~
- ~~Prompt-compatible API aliases. Done: `POST /class-sessions/:sessionId/whiteboard/restore-previous` and `GET /class-sessions/:sessionId/whiteboard/search` are available alongside the existing whiteboard memory endpoints.~~
- Optional AI summary later, intentionally not implemented in Phase 8:
  - key formulas
  - solved problems
  - homework questions

Outcome:

~~The whiteboard becomes part of the learning record, not just a temporary drawing surface. Done: live class boards now persist as recoverable session memory with checkpoints, previous-session restore, and searchable page metadata.~~

Verification:

- Contracts build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/contracts`.
- Backend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/backend`.
- Frontend build passed with the repo-supported Node 22 runtime: `npm run build --workspace @native-sfu/frontend`.
- Focused backend class-session spec passed: `npm test --workspace @native-sfu/backend -- class-sessions.service.spec.ts`.
- Sandboxed Angular/esbuild build still exits with the known local `134` abort after starting `ng build`; the elevated Node 22 build is the verified result.

Intentional Phase 8 limits:

- No AI summary or AI extraction is implemented in this phase.
- Selected-page PDF export is now available from the whiteboard menu, while attached class notes still use the existing all-pages board-note flow.
- Version history stores bounded full-board snapshots, not a per-operation durable edit log.

## Graduation-Level Priority Set

For graduation-level math, the highest-value features are:

1. ~~LaTeX equation blocks. Done in Phase 3.~~
2. ~~Multi-page board. Done in Phase 2.~~
3. ~~PDF/slides annotation. Done in Phase 6.~~
4. ~~Graph plotting. Done in Phase 4.~~
5. Matrix/table tool. Partially covered by matrix snippets and table-layout templates; a full editable matrix/table editor remains future work.
6. ~~Coordinate and graph templates. Done in Phases 2 and 4.~~
7. ~~Export notes as PDF. Done in Phase 6.~~
8. ~~Selective student control. Done in the class-session whiteboard control flow.~~

## Recommended Build Order

Short-term:

- ~~Finish production board basics. Done in Phase 1.~~
- ~~Add multi-page board. Done in Phase 2.~~
- ~~Add grid/graph templates. Done in Phase 2.~~
- ~~Add PDF/image export. Done in Phase 2.~~

Mid-term:

- ~~Add LaTeX equation blocks. Done in Phase 3.~~
- ~~Add graph plotting. Done in Phase 4.~~
- ~~Add geometry tools. Done in Phase 5.~~
- ~~Add PDF/slides import and annotation. Done in Phase 6.~~
- ~~Add lesson asset annotation and saved class notes. Done in Phase 6.~~

Long-term:

- ~~Add academic board persistence. Done in Phase 8.~~
- ~~Add searchable lesson notes. Done at saved whiteboard page title/tag level in Phase 8; deeper full-text note search remains future work.~~
- Add deeper analytics around whiteboard participation.

## Non-Goals For Now

- Do not replace whiteboard-as-video sharing.
- Do not make every student collaborative by default.
- Do not build a separate realtime whiteboard stack if existing session/socket infrastructure can be reused.
- Do not overbuild CAS-level symbolic math in the first version.

## Product Framing

The target is not only "a whiteboard." The target is a live academic teaching workspace:

- Teacher explains.
- Students watch clearly.
- One student can participate when allowed.
- The board becomes notes.
- Notes become materials.
- Materials remain attached to the learning journey.
