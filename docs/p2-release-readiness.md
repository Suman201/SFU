# P2 release readiness

Updated: 26 November 2026. This closes the repository implementation scope for the P2 product baseline. Deployment approval and environment evidence remain separate.

## Classroom policies

Teachers can apply Teaching, Discussion or Controlled entry to an owned batch from batch details or its live settings editor. The server merges only the preset policy fields; recording, consent, retention and billing settings remain independent. Applying a preset requires the audit service and records its identifier and future-session scope. Individual fields remain editable.

A new class snapshots the effective batch settings when it starts. Changing a batch never changes the live session. Controlled entry starts locked with a waiting room, muted microphones, cameras off, private chat paused and student drawing disabled. The teacher opens entry, admits students where waiting room is enabled, and grants speaking, chat or board controls explicitly. A reconnect uses the session's initial entitlements, so paused chat may require a fresh teacher grant. Paused students can still read their conversation; socket writes remain permission checked.

## Accessibility and localization

Preflight and student prejoin keep keyboard focus inside the modal, support Escape and restore prior focus where it still exists. A nested native device dialog handles Escape without leaving its parent. Existing named controls and live status regions are retained. The classroom language selector persists English or Hindi for entry, media status, whiteboard source and chat status strings; untranslated product areas remain English. This is a localization foundation, not full-site translation.

P2 acceptance checks real keyboard wrap, Enter actions, nested Escape, responsive layouts and focused axe rules including contrast and accessible names. P0/P1 retain actual chat, media, reconnect and whiteboard coverage. Automated checks do not replace physical assistive-technology testing or establish full WCAG conformance. Interaction patterns follow the [WAI dialog guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/); scans use [axe Playwright](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright).

## CMS, contact and audit

The admin editor supports adding, editing, moving and removing typed sections, links and FAQ/feature items, with advanced JSON retained. Unsupported blocks, unsafe URLs and malformed nested entries are rejected. Existing content read/write permissions also govern history and restore operations.

Saving a published page changes its working copy. Public routes continue serving the last publication until explicit publication. MongoDB transactions atomically save an immutable content snapshot, canonical SHA-256 content digest, actor, timestamp and increasing publication number with the page. Publishing identical content is idempotent. Stale editor revisions return 409. Restore copies a publication into the working draft and requires a separate publish. An archived page reopens as an unpublished draft. Published routing fields require explicit unpublish before changes. Built-in public URLs remain supported; custom pages use `/pages/:slug`.

Run `npm run setup:cms` on a reviewed replica-set database before rollout. This creates collections and indexes idempotently and preserves content. Legacy published pages remain readable; their current copy is frozen before the first draft edit, and the first explicit publication starts numbered history. There is no invented historical archive or destructive content backfill. Publication refuses standalone MongoDB. Deploy backend, contracts and admin together because old admin clients do not show the new draft/publish distinction. Keep that behavior when rolling back; do not roll back to a backend that exposes working drafts publicly.

Contact acceptance uses actual submission, staff reply and delivery to an isolated SMTP sink. Audit acceptance inspects real persisted CMS/contact events and ensures legal, contact and reply bodies are absent. Existing audit explorer, attendance analytics, recording analytics, support health and teacher promotion foundation remain part of the product baseline. A media library/picker and monetized promotion plans are future product scope, not implemented or priced by this release.

## Repeatable repository gates

Use Node 22.22.3, locked dependencies, Docker, FFmpeg/FFprobe and installed headless Chromium, Firefox and WebKit. Build shared dependencies before the backend/clients. Never rebuild them during browser acceptance; suites share fixed ports and run sequentially.

```sh
npm run build:admin-ci
npm run contracts:check
npm run release:check
npm run test:p0:backend
npm run test:p0:frontend
npm run test:admin:unit
npm run test:p1:workers
npm run build:p0:classroom
node scripts/p0-ci-services.cjs up
npm run test:p0:browser
npm run test:p1:browser
npm run test:p2:browser
node scripts/p0-ci-services.cjs down
```

The browser wrapper allows only its owned loopback replica set and Redis database, uses synthetic users, and disables external payment providers. P2 enables email only to a loopback sink. CMS/contact/history acceptance runs in Chromium, Firefox and WebKit; classroom device acceptance uses headless Chromium fake devices. Reports and actual screenshots are saved in ignored `reports/p2/`; CI retains these with logs and failure traces. The setup idempotency check runs repeatedly against existing fixture data. CI also gates existing admin/payment integration, scanner and recovery drills.

The multi-node regression includes idempotent per-process producer, consumer and transport accounting and atomic disconnect ownership: a stale socket cannot remove a replacement participant, and overlapping cleanup cannot decrement a native transport twice. Bounded two-node tests establish no production capacity claim.

## Local verification on 26 November 2026

- Full production build chain, reviewed contract baseline and release inventory checks pass.
- Backend: 68 suites and 810 tests. Learning portal: 237 tests. Admin: 12 tests. Native worker lifecycle: 13 tests. Admin/payment integration: 32 scenarios.
- All three P0 journeys pass, including actual SFU video, recording, reconnect, authorized playback, private questions, invoices and calendar delivery.
- All six P1 checks pass, including two-node recovery/isolation, native UDP pipes in both directions and private historical Q&A in Chromium, Firefox and WebKit. Final native and local transport counts return to zero. Producer and consumer gauges also return to zero, including owner-side remote teardown.
- P2 classroom acceptance and all three CMS/contact/audit browser workflows pass. CMS was rechecked in all engines after correcting Firefox intrinsic grid sizing at 390px. Focused accessibility scans report no violations for the selected rules and regions; actual desktop, phone and tablet screenshots were reviewed.

These results describe isolated local fixtures. The deployment and independent operator gates below remain open.

## Remaining deployment proof

Use [the release checklist](release-checklist.md) to record the exact green commit and independent approvals. Required external evidence remains: target MongoDB replica-set/index verification and backup restore; approved legal copy and retention; production Stripe/SMTP delivery; TURN/ICE and ingress on the actual host; expected-duration load and outage drills; physical mobile/browser and screen-reader checks; an independent operator executing the runbook; and named incident contacts. None is marked approved by local tests, documentation checks or a push to main. No production deployment is performed by these gates.

[Environment inventory](environment-reference.md), [deployment guide](deployment.md), [operator runbook](operator-runbook.md) and [P1 readiness](p1-release-readiness.md) provide the configuration and operational context.
