# Whiteboard Math Teaching Roadmap

## Purpose

The current whiteboard is useful as a general live-class teaching surface: teachers can draw, explain, annotate, and share the board as video during a class session. For serious school, college, and graduation-level math teaching, the whiteboard should evolve into a math-aware academic workspace.

This roadmap phases that evolution without replacing the existing whiteboard-as-video flow.

## Current Capability

The current whiteboard direction supports:

- Freehand drawing and writing.
- Pen, eraser, color, and shape-oriented workflows.
- Teacher-led use during live class.
- Whiteboard-as-video sharing through the existing media path.
- Teacher camera PiP while the board is shared.
- Potential selective student control for participation.
- Recording visibility because the board is shared as a media stream.

This is enough for basic explanation, rough working, and interactive teaching, but not enough for production-grade academic math instruction.

## Core Product Goal

The whiteboard should become a flexible teaching canvas that supports both:

- Natural thinking: freehand writing, quick sketches, corrections, annotations.
- Structured math work: equations, graphs, geometry, proofs, pages, exports, and reusable lesson assets.

## Phase 1: Production Teaching Board

Goal: Make the current board feel reliable and premium for daily classes.

Scope:

- Better eraser behavior, including stroke-level and partial erase modes.
- Closed-shape fill and editable fill color.
- Full color picker, not only predefined colors.
- Marquee multi-select.
- Keyboard shortcuts:
  - Delete
  - Undo / redo
  - Zoom in / zoom out
  - Escape to deselect
  - Copy / paste / duplicate
- Context menu actions:
  - Remove
  - Bring forward / send backward
  - Flip horizontal / flip vertical
- Layer ordering behavior.
- Better closed-shape detection for nearly closed loops.
- Stable zoom, pan, and selection behavior.

Outcome:

Teachers can confidently use the board as a polished general whiteboard for school-level and coaching-style classes.

## Phase 2: Math-Friendly Templates

Goal: Add teaching structure without requiring advanced math input.

Scope:

- Grid background.
- Graph-paper background.
- Ruled notebook background.
- Coordinate axes template.
- Number line template.
- Geometry construction background.
- Table layout template.
- Fraction bar template.
- Multiple board pages.
- Page thumbnails or page tabs.
- Export board page as image.
- Export full board as PDF.

Outcome:

Math teachers can teach arithmetic, algebra, coordinate geometry, and basic statistics with a board that feels intentionally built for education.

## Phase 3: Math Text and Equation Blocks

Goal: Support clean academic notation while preserving freehand flow.

Scope:

- Insert equation block.
- LaTeX-style math input.
- Editable rendered equations.
- Common math shortcuts:
  - Fractions
  - Powers and subscripts
  - Square roots
  - Greek letters
  - Integrals
  - Summations
  - Limits
  - Vectors
  - Matrices
- Inline text and math labels.
- Equation duplication and alignment.
- Convert typed math to rendered math.

Outcome:

Teachers can present clean algebra, calculus, linear algebra, and proof notation without struggling with freehand precision.

## Phase 4: Graphing and Visualization

Goal: Make the board useful for higher math and science-style explanation.

Scope:

- Plot function from equation.
- Editable 2D graph object.
- Axes, scale, tick, and grid controls.
- Point, line, curve, tangent, and area tools.
- Inequality region shading.
- Parametric curve support.
- Basic polar graph support.
- Moveable labels and annotations.
- Simple statistics plots:
  - Histogram
  - Scatter plot
  - Regression line
  - Normal curve

Outcome:

Graduation-level teachers can explain calculus, coordinate geometry, probability, statistics, and applied math visually.

## Phase 5: Geometry and Diagram Tools

Goal: Add precision tools for geometry, vectors, and diagram-heavy subjects.

Scope:

- Ruler / straightedge.
- Protractor.
- Compass-style circle construction.
- Angle measurement.
- Snap-to-point and snap-to-grid.
- Vector arrows.
- Polygon tools.
- Parallel/perpendicular helpers.
- Venn diagram tool.
- Graph theory node/edge tool.
- Tree diagram tool.

Outcome:

Teachers can build accurate diagrams for geometry, vectors, graph theory, discrete math, and probability.

## Phase 6: Lesson Assets and Annotation

Goal: Let teachers teach from prepared materials while keeping whiteboard freedom.

Scope:

- Import PDF.
- Import image.
- Import slide deck or exported slide images.
- Annotate over imported pages.
- Move between material pages.
- Add blank whiteboard pages between imported pages.
- Save annotated lesson output.
- Attach exported board notes to the class session.

Outcome:

Teachers can combine prepared notes, slides, textbook screenshots, and live explanation in one classroom workflow.

## Phase 7: Interactive Student Participation

Goal: Make the board collaborative in a controlled classroom-safe way.

Scope:

- Teacher grants whiteboard control to one student.
- Teacher revokes control.
- Student can draw/write only while allowed.
- Teacher sees student cursor.
- Other students remain view-only.
- Teacher can lock board.
- Teacher can clear student changes or keep them.
- Student attempts and solutions can be saved as part of class notes.

Outcome:

The board supports solving, participation, viva-style explanation, and teacher-guided correction without becoming chaotic.

## Phase 8: Academic Session Memory

Goal: Turn whiteboard work into reusable learning material.

Scope:

- Persist board state per class session.
- Resume board after reconnect.
- Restore board from previous session.
- Version history.
- Export selected pages.
- Export class notes PDF.
- Attach notes to batch/session materials.
- Search board pages by title or tags.
- Optional AI summary later:
  - key formulas
  - solved problems
  - homework questions

Outcome:

The whiteboard becomes part of the learning record, not just a temporary drawing surface.

## Graduation-Level Priority Set

For graduation-level math, the highest-value features are:

1. LaTeX equation blocks.
2. Multi-page board.
3. PDF/slides annotation.
4. Graph plotting.
5. Matrix/table tool.
6. Coordinate and graph templates.
7. Export notes as PDF.
8. Selective student control.

## Recommended Build Order

Short-term:

- Finish production board basics.
- Add multi-page board.
- Add grid/graph templates.
- Add PDF/image export.

Mid-term:

- Add LaTeX equation blocks.
- Add PDF/slides import and annotation.
- Add graph plotting.

Long-term:

- Add geometry tools.
- Add academic board persistence.
- Add searchable lesson notes.
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
