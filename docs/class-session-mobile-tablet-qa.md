# Class Session Mobile And Tablet QA

Updated: 2026-06-25

This note tracks the P0 mobile/tablet hardening pass for live class-session pages.

## Status

Code hardening has been applied for the teacher and student live class-session layouts. Real screenshot proof is still pending because the current local verification environment does not provide a seeded authenticated live class with teacher and student clients, camera/screen producers, materials, chat threads, and whiteboard share state.

No mockups were used as proof.

How to read this document: fully struck-through lines are complete. Unstruck lines remain open.

## Hardening Applied

- ~~Student waiting/error pages now use dynamic viewport height and safe-area padding. Done.~~
- ~~Student live controls reserve extra bottom space when media errors or network warnings add rows. Done: this reduces PiP/chat overlap risk.~~
- ~~Student live controls, top actions, drawer close buttons, and media buttons have coarse-pointer tap target hardening. Done.~~
- ~~Student materials drawer now uses full drawer mode instead of compact sidebar mode. Done.~~
- ~~Materials drawer content scrolls internally instead of growing beyond the drawer. Done.~~
- ~~Teacher waiting/error pages now use dynamic viewport height and safe-area padding. Done.~~
- ~~Teacher tablet portrait gets a larger whiteboard row so the canvas stays meaningful before the sidebar. Done.~~
- ~~Teacher media menu, drawer triggers, device controls, status strip, and participant moderation buttons have coarse-pointer tap target hardening. Done.~~
- ~~Teacher class-session shell uses contained touch behavior while preserving canvas-specific drawing behavior. Done.~~

## Verification Completed

- ~~Frontend build. Done: `npm run build --workspace @native-sfu/frontend` passed with the repo-supported Node 22 runtime outside the sandbox.~~
- ~~Focused teacher class-session spec. Done: `npm test --workspace @native-sfu/frontend -- --include=src/app/features/class-session/teacher/class-session.spec.ts` passed with `TOTAL: 9 SUCCESS`.~~
- ~~Whitespace check. Done: `git diff --check` passed.~~

## Verification Blocked

- Focused chat spec: `npm test --workspace @native-sfu/frontend -- --include=src/app/features/class-session/session-chat/session-chat.spec.ts` currently connects ChromeHeadless and then hits a Karma ping timeout before executing specs.
- Real screenshot proof: pending until a seeded authenticated live class can be opened for both teacher and student clients.

## Viewport Matrix To Prove In Browser

Target mobile portrait:

- 360x740
- 390x844
- 430x932

Target mobile landscape:

- 740x360
- 844x390
- 932x430

Target tablet portrait:

- 768x1024
- 820x1180

Target tablet landscape:

- 1024x768
- 1180x820

Desktop regression:

- 1366x768
- 1440x900

## Required Screenshot States

Student:

- prejoin modal
- live camera-only stage
- live screen or whiteboard share with teacher PiP
- chat open
- materials open
- participant panel open
- reconnecting state
- ended/forbidden state

Teacher:

- whiteboard default
- 3-dot menu open
- device settings drawer open
- class status drawer open
- participant sidebar/cards
- confirmation modal open
- chat/private/broadcast visible
- whiteboard math/templates menu open

## Verification Commands

Run after future changes:

- `npm run build --workspace @native-sfu/frontend`
- `npm test --workspace @native-sfu/frontend -- --include=src/app/features/class-session/teacher/class-session.spec.ts`
- `npm test --workspace @native-sfu/frontend -- --include=src/app/features/class-session/session-chat/session-chat.spec.ts`
- `git diff --check`

## Screenshot Blocker

The existing Playwright suite is focused on staging/network browser proof and does not include local authenticated class-session visual fixtures. Before marking this P0 item complete, add or run a real seeded browser session that can open teacher and student live classrooms and capture the matrix above.
