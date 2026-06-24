# Whiteboard Canvas Capture Sharing Plan

## Summary

The fastest production path for student-side whiteboard visibility is to treat the teacher whiteboard as a shareable media source.

Instead of asking the teacher to use browser screen share, the teacher clicks **Share Whiteboard**. The app captures the whiteboard canvas with `HTMLCanvasElement.captureStream()` and publishes that stream through the existing SFU screen-share path. Students then see the whiteboard as the main stage video, while the teacher camera remains in the existing PiP layout.

This keeps the current teacher-only whiteboard model and avoids building full collaborative whiteboard sync before it is actually needed.

## Product Direction

### Current Gap

- Teacher class-session renders the whiteboard.
- Student class-session does not render the whiteboard.
- Backend/session payload already includes `whiteboardChannelId`, but the frontend is not currently syncing whiteboard commands.
- The existing student media layout already knows how to prioritize a screen producer as the main stage.

### Proposed Behavior

- Teacher sees a **Share Whiteboard** button near the whiteboard/session controls.
- When enabled, the whiteboard canvas is captured as a `MediaStream`.
- The stream is published as the existing screen-share producer type.
- Student view behaves like a tutorial layout:
  - Whiteboard video is the main full-stage media.
  - Teacher camera remains a floating PiP bubble at bottom-right.
- When teacher stops sharing, students fall back to teacher camera as the main stage.

## Why Canvas Capture Instead Of Browser Screen Share

Canvas capture is better for this product flow because:

- It is one-click inside the classroom UI.
- It does not require the browser screen picker.
- It captures only the whiteboard, not private desktop/browser content.
- It reuses the existing SFU screen-share pipeline and student stage layout.
- It keeps the whiteboard as a controlled classroom feature instead of a generic desktop-share action.

Browser screen share should remain available for sharing external slides, documents, or other apps.

## Non-Goals

This plan does not implement collaborative whiteboard editing yet.

Students will initially watch the whiteboard as video only. They cannot directly interact with the board through the media stream.

Selective student interaction should be implemented later as real whiteboard command sync, not by trying to interact with the video stream.

## Technical Design

### Whiteboard Component

Expose a small capture API from the shared whiteboard component:

```ts
captureMediaStream(fps = 15): MediaStream | null
```

Implementation shape:

- Use the whiteboard canvas element.
- Call `canvas.captureStream(fps)` when supported.
- Return the resulting stream.
- If unsupported, return `null` so the teacher UI can show a fallback or suggest browser screen share.

Optional hardening:

- Expose a `requestCaptureFrame()` helper if the returned `CanvasCaptureMediaStreamTrack` supports `requestFrame()`.
- Force a redraw when sharing starts so students receive an immediate frame.
- Recreate the stream if the canvas backing size changes.

### Teacher Class Session

Teacher class-session owns the share lifecycle:

- Add `@ViewChild` access to the whiteboard component.
- Add a compact **Share Whiteboard / Stop Whiteboard Share** control.
- On start:
  - Ensure the session is live.
  - Stop or disable generic screen share if only one screen-like producer is allowed.
  - Capture the whiteboard stream.
  - Publish it through the existing WebRTC/SFU screen producer flow.
  - Track local state as `whiteboardSharing`.
- On stop:
  - Close only the whiteboard screen producer.
  - Stop local capture tracks.
  - Emit/let existing producer closed events update students.

The implementation should not create a parallel media stack.

### Student Class Session

Student side should need minimal UI change if the existing layout already prioritizes screen producers:

- If a teacher screen producer exists, render it as the main stage.
- If that producer is the whiteboard capture, it naturally appears in the same main stage.
- Teacher camera remains PiP.
- If the whiteboard share stops, fall back to teacher camera as the main stage.

Optional polish:

- Label the main stage as **Whiteboard** when producer metadata identifies it as whiteboard capture.
- Show a short loading state while the screen/whiteboard stream is attaching.

### Producer Metadata

If existing producer metadata supports it, tag the whiteboard capture:

```ts
{
  source: 'whiteboard',
  kind: 'screen',
  label: 'Whiteboard'
}
```

This helps the student UI, recording UI, analytics, and debugging distinguish browser screen share from whiteboard share while still reusing the screen-share rendering path.

## Recording Compatibility

If server-side recording already records screen producers, whiteboard sharing should be included automatically when published as a screen-like producer.

Verification is still required:

- Recording starts before whiteboard share.
- Recording starts after whiteboard share.
- Whiteboard share stops during recording.
- Teacher switches between browser screen share and whiteboard share.

## Edge Cases

### Browser Support

`canvas.captureStream()` is widely available in modern Chromium and Firefox, but browser support should be checked for Safari/iOS behavior. If unsupported, show a clear fallback message and keep browser screen share available.

### Canvas Tainting

If the whiteboard draws cross-origin images without proper CORS headers, the canvas can become tainted. That can break export and may break capture behavior. Image imports should either use same-origin/server-stored assets or CORS-safe loading.

### Text And HTML Overlays

Canvas capture records only canvas pixels. HTML overlays, popovers, toolbars, or active text input controls are not captured until they are committed/drawn onto the canvas.

### Idle Frames

Some browsers may not push frequent frames when the canvas is idle. Force a redraw when sharing starts and consider requesting frames after whiteboard commands.

### Canvas Resize

Canvas resize can affect captured stream resolution. The share flow should be tested across resize, fullscreen, and responsive classroom layouts.

### Background Tabs

Browsers may throttle canvas rendering in background tabs. Teacher-side UX should warn if sharing quality drops or the tab is backgrounded during a live class.

## Future Interactive Whiteboard

When the product needs student interaction, add a separate **Allow Whiteboard Control** flow:

- Teacher selects one student or a small group.
- Backend authorizes the student for the `whiteboardChannelId`.
- Student UI renders the whiteboard surface.
- Student actions send structured whiteboard commands over socket.
- Teacher and allowed students receive synced commands and cursor presence.

That future work should use command sync, not video-stream interaction.

Suggested command model:

- `whiteboard:command`
- `whiteboard:cursor`
- `whiteboard:permission-granted`
- `whiteboard:permission-revoked`

The video sharing path and the interactive command path can coexist:

- Video share is for all students watching.
- Command sync is for selected students interacting.

## Suggested Files

- `apps/frontend/src/app/shared/whiteboard/whiteboard.ts`
- `apps/frontend/src/app/features/class-session/teacher/class-session.ts`
- `apps/frontend/src/app/features/class-session/teacher/class-session.html`
- `apps/frontend/src/app/features/class-session/teacher/class-session.scss`
- `apps/frontend/src/app/features/class-session/student/class-session.ts`
- `apps/frontend/src/app/features/class-session/student/class-session.html`
- `apps/frontend/src/app/core/services/webrtc.service.ts`
- `apps/frontend/src/app/core/services/room.store.ts`
- `packages/contracts/src/signaling.ts`

Backend changes should be minimal unless producer metadata requires a contract update.

## Acceptance Criteria

- Teacher can start whiteboard sharing with one in-class button.
- Teacher can stop whiteboard sharing without ending the session.
- Students see the shared whiteboard as the main stage video.
- Teacher camera remains visible as PiP when whiteboard sharing is active.
- Students fall back to teacher camera when whiteboard sharing stops.
- Existing browser screen share still works.
- Existing chat, media, moderation, device switching, lifecycle, recording, and reconnect behavior remain intact.
- No full collaborative whiteboard sync is introduced in this step.
