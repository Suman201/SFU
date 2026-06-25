# Repo-Wide Production Readiness Gaps

Updated: 2026-06-25

This document tracks production gaps across the full Native SFU repo, not only the live class-session surface.

Related focused docs:

- `docs/class-session-production-gaps.md`
- `docs/operator-runbook.md`
- `docs/security.md`
- `docs/testing.md`
- `docs/mediasoup-gap-roadmap.md`
- `docs/pipe-transport.md`
- `docs/unproven-checklist.md`

## Status Labels

- **Done**: implemented and verified enough to close the item.
- **Pending Proof**: implemented or partially implemented, but needs runtime, staging, screenshot, browser, or test evidence.
- **Blocker**: must be resolved before the relevant production milestone.
- **Tracked**: important follow-up that should stay visible, but may not block the immediate milestone.

## Repo Readiness Estimate

| Target | Estimated readiness | Remaining gap |
| --- | ---: | ---: |
| Local internal demo | 90-94% | 6-10% |
| Controlled single-node pilot | 78-85% | 15-22% |
| Serious paid-user production | 68-78% | 22-32% |
| Large-scale or multi-node production | 52-65% | 35-48% |

The repo has many production-shaped features in place: manual class-session lifecycle, SFU media, private chat, admin modules, attendance analytics, recordings, whiteboard upgrades, materials, audit-style surfaces, and operational scripts. The remaining gap is mainly proof, reliability, security hardening, runtime evidence, deployment confidence, and scale validation.

## Workspace Map

| Area | Path | Production gap summary | Status |
| --- | --- | --- | --- |
| Backend API and sockets | `apps/backend` | Needs full green test/build/dev proof, auth edge-case coverage, staging WebRTC proof, and operational hardening evidence. | **Pending Proof** |
| Teacher/student portal | `apps/frontend` | Needs real runtime screenshots, mobile/tablet QA proof, browser media proof, and demo/static data sweep. | **Pending Proof** |
| Admin portal | `apps/admin-portal` | Needs admin workflow QA, route-level access proof, dashboard/module smoke proof, and production config proof. | **Pending Proof** |
| Shared contracts | `packages/contracts` | Needs contract drift checks across backend/frontend/admin and versioned release discipline. | **Pending Proof** |
| SFU core packages | `packages/sfu-core`, `packages/nest-sfu` | Needs media interoperability, staging TURN/UDP proof, multi-node pipe proof, and load/soak evidence. | **Blocker** for scale |
| Infra | `infra` | Needs production secret handling, ingress/TURN validation, backups, retention, observability access control, and multi-node runbooks. | **Blocker** |
| Tests and scripts | `tests`, `scripts` | Good coverage scaffolding exists, but CI/dev-mode/browser/load signoff must be repeatable and recorded. | **Pending Proof** |
| CI/CD | `.github` or external CI | No repo-local GitHub workflow directory was found during this review. CI source of truth must be confirmed. | **Blocker** |

## P0: Build, Test, And Dev Runtime Proof

Status: **Blocker** for pilot.

Production readiness cannot rely on build success alone. The repo must prove that all runtime modes start and talk to each other.

Required proof:

- `npm run verify:build`
- `npm run build --workspace @native-sfu/contracts`
- `npm run build --workspace @native-sfu/sfu-core`
- `npm run build --workspace @native-sfu/nest-sfu`
- `npm run build --workspace @native-sfu/backend`
- `npm run build --workspace @native-sfu/frontend`
- `npm run build --workspace @native-sfu/admin-portal`
- `npm run dev:backend`
- `npm run dev:frontend`
- `npm run dev:admin-portal`
- `npm run verify:dev:smoke`
- backend health endpoint responds
- frontend teacher/student route shells load
- admin portal dashboard/module route shells load
- Socket.IO connects from frontend to backend
- runtime `/env.js` or equivalent config points to the intended API/socket origins

Known gap:

- Dev-server proof was previously blocked in the side sandbox by local port/browser restrictions. That is not product proof either way. A real local or staging runtime signoff is still required.

## P0: CI/CD Source Of Truth

Status: **Blocker** for production.

The root `package.json` has strong verification scripts, but this review did not find a repo-local `.github` workflow directory.

Required proof:

- identify the real CI provider and workflow source
- CI runs on every PR
- CI uses supported Node version from `package.json`
- CI runs contract, backend, frontend, admin portal, and package builds
- CI runs backend unit/e2e tests
- CI runs frontend/admin lint or compile checks
- CI runs browser smoke tests where feasible
- CI stores artifacts for screenshots, logs, and failed browser traces
- release tags are tied to green CI runs

## P0: Security And Access Control

Status: **Blocker** until validated in staging.

Required proof:

- production secrets are not committed
- `TURN_SECRET`, JWT secrets, operation tokens, webhook secrets, and recording/storage credentials are unique and rotated
- Swagger is disabled in production or protected behind operator auth
- diagnostics, metrics, and operator endpoints require authorization
- CORS allows only production origins
- frontend/admin portal do not ship localhost API/socket config
- unauthorized students cannot read, watch, join, chat, load materials, view recordings, or download files for other batches
- lifecycle watcher authorization rejects guessed session IDs
- socket room joins and targeted events do not leak across rooms
- private chat and moderation events target participant/user sockets only
- admin portal routes and backend admin endpoints enforce admin/super-admin roles

Repo areas:

- `apps/backend`
- `apps/frontend`
- `apps/admin-portal`
- `packages/contracts`
- `infra/k8s/secret.example.yaml`
- `infra/docker-compose.prod.yml`

## P0: Frontend Runtime And UX Proof

Status: **Blocker** for pilot.

Required teacher/student portal proof:

- login works against the real backend
- student dashboard data is backend-driven
- teacher dashboard data is backend-driven
- class-session entry uses backend metadata
- profile/settings screens are backend-driven or explicitly demo-gated
- no remaining ungated demo/static data on production routes
- real teacher-side class-session screenshot set is captured
- real student-side class-session screenshot set is captured
- teacher camera renders for students
- screen share and whiteboard share render as primary media
- PiP layout does not hide controls
- app-native modals replace native destructive confirms
- 3-dot teacher controls and device settings drawer work on desktop and touch viewports

Target paths to keep under review:

- `apps/frontend/src/app/features/class-session`
- `apps/frontend/src/app/features/student`
- `apps/frontend/src/app/features/teacher`
- `apps/frontend/src/app/features/profile`
- `apps/frontend/src/app/core/services`
- `apps/frontend/src/styles.scss`

## P0: Admin Portal Runtime And Workflow Proof

Status: **Pending Proof**.

Required proof:

- admin login works against the real backend
- default dashboard route loads
- class sessions list/detail loads
- attendance analytics and drilldown load
- recordings list/detail loads
- enrollment oversight loads and updates real backend state
- user management enforces roles
- course and batch management use backend data
- audit/operator views load if present
- CSV/download actions work
- tables use the shared admin table UI classes where applicable
- unauthorized users cannot access admin routes or admin APIs

Target paths:

- `apps/admin-portal/src`
- `apps/backend/src/admin`
- `packages/contracts/src`

## P0: Class-Session Production Proof

Status: **Blocker** for pilot until the focused class-session proof is complete.

Use `docs/class-session-production-gaps.md` as the detailed source of truth.

Repo-wide summary:

- manual lifecycle must remain explicit
- teacher reconnect grace must be proven
- enrolled-only access must be proven
- private chat and teacher broadcast must be proven
- teacher/student media must be proven in real browser sessions
- device switching must be proven
- moderation controls must be permissioned and reflected in UI
- whiteboard share and selective control must be proven
- materials, recordings, attendance, and board notes must be access-protected
- mobile/tablet proof must include real screenshots, not mockups

## P0: Media Plane And WebRTC Staging Proof

Status: **Blocker** for production.

Required proof:

- public ICE host candidate reachability
- TURN relay with real credentials
- UDP media port exposure for `HOST_CANDIDATE_PORT_RANGE`
- correct `ICE_ANNOUNCED_ADDRESS`
- browser publish/subscribe through real staging ingress
- Socket.IO reconnect through real ingress
- camera, microphone, screen share, and whiteboard-as-video work on staging
- consume failures are visible and recoverable
- media publish failures are logged with useful context
- host disconnect/reconnect does not strand sessions
- recording remains stable while producers change

Related files:

- `docs/media-plane.md`
- `docs/mediasoup-gap-roadmap.md`
- `docs/pipe-transport.md`
- `tests/browser/*interoperability.spec.ts`
- `tests/browser/staging-turn-validation.spec.ts`
- `tests/browser/staging-ingress-browser-proof.spec.ts`

## P1: Scale And Multi-Node Proof

Status: **Blocker** for large-scale or multi-node production.

Required proof:

- owner routing works across nodes
- reconnect lands on the correct owner or redirects safely
- pipe transport behavior is validated when enabled
- node drain does not strand sessions
- cross-node private chat remains private
- targeted moderation and lifecycle socket events remain targeted
- no private chat, materials, whiteboard-control, or moderation leakage across rooms/nodes
- load balancer and sticky-session behavior are documented
- Redis/socket adapter behavior is validated if used

Related files:

- `docs/pipe-transport.md`
- `docs/mediasoup-gap-roadmap.md`
- `docs/unproven-checklist.md`
- `tests/load/node-drain-soak.js`

## P1: Soak, Load, And Degradation Testing

Status: **Blocker** for broad production.

Required proof:

- long-running class sessions on the actual server class
- multiple concurrent live classes
- room join/leave churn
- media publish/consume churn
- private chat, broadcast chat, whiteboard, and materials event churn
- teacher reconnect grace under network loss
- Redis behavior under expected event volume
- Mongo behavior under expected write volume
- memory, CPU, worker, and mediasoup health over time
- graceful degradation when TURN, Mongo, Redis, or recording services are degraded

Related scripts:

- `npm run test:load:socketio`
- `npm run test:load:node-drain`
- `npm run test:live-soak`
- `npm run test:eventing:soak`
- `npm run test:staging:preflight`

## P1: Observability, Audit, And Runbooks

Status: **Pending Proof**.

Required production signals:

- session started and ended
- teacher disconnected and reconnected
- reconnect grace timer started, cancelled, and expired
- student join denied and admitted
- media publish/consume failures
- chat send/read failures
- recording start/stop/failure
- moderation actions
- whiteboard control grants/revokes
- material share/upload/download events
- admin changes to users, enrollments, courses, batches, and recordings

Required runbooks:

- stuck live session
- teacher cannot publish media
- students cannot consume media
- TURN relay failure
- recording failed
- chat delivery issue
- unauthorized access report
- Mongo degraded
- Redis degraded
- node drain or owner-routing incident

Related files:

- `docs/operator-runbook.md`
- `infra/prometheus/prometheus.yml`
- `infra/grafana/provisioning/dashboards/native-sfu.json`

## P1: Data Durability, Backups, And Retention

Status: **Blocker** for paid-user production.

Required proof:

- Mongo backup and restore tested
- Redis persistence or acceptable-loss policy documented
- recordings storage backup/retention policy exists
- chat attachment and material storage retention policy exists
- attendance snapshot retention policy exists
- audit log retention policy exists
- deleted user, deleted enrollment, and deleted material behavior is defined
- restore drill is documented with target RPO/RTO

Repo areas:

- `apps/backend/src`
- `infra`
- `docs/operator-runbook.md`
- `docs/security.md`

## P1: Recording And Playback Proof

Status: **Pending Proof**.

Required proof:

- server-side recording starts and stops reliably
- recording status survives reconnects where intended
- failed recording states are visible to teacher/admin
- playback manifests are access-protected
- students can only access authorized recordings
- admin recording management can inspect failures
- whiteboard-as-video and screen share are recorded as expected
- recording retention and deletion policy is enforced

## P1: File, Attachment, And Material Storage

Status: **Pending Proof**.

Required proof:

- upload size limits are enforced
- MIME/type validation is enforced
- unsafe file names are sanitized
- download endpoints are authorized
- chat attachments remain private or broadcast-scoped correctly
- materials are batch/session access-protected
- local storage path is suitable for the deployment target or replaced by durable object storage
- virus/malware scanning policy is defined if accepting arbitrary documents

## P1: Cross-Browser And Device Confidence

Status: **Pending Proof**.

Required coverage:

- Chrome/Chromium
- Firefox
- WebKit/Safari
- iOS Safari camera/mic permission behavior
- Android Chrome camera/mic behavior
- autoplay and `playsinline` behavior
- mobile virtual keyboard behavior in chat
- touch drawing behavior on whiteboard
- tablet teacher moderation and drawers

Related commands:

- `npm run test:browser:chromium`
- `npm run test:browser:firefox`
- `npm run test:browser:webkit`

## P1: Contracts And API Compatibility

Status: **Pending Proof**.

Required proof:

- contract package builds before every app build
- backend, frontend, and admin portal use the same contract version
- socket event contracts cover lifecycle, media, chat, moderation, materials, whiteboard, and recording events
- breaking changes are detected before merge
- legacy clients fail safely or are blocked during incompatible deploys

Repo areas:

- `packages/contracts/src`
- `apps/backend/src`
- `apps/frontend/src`
- `apps/admin-portal/src`

## P2: Documentation And Release Discipline

Status: **Tracked**.

Required before broad production:

- production deployment guide updated
- staging signoff checklist updated
- rollback plan documented
- incident contacts and escalation paths documented
- release checklist includes screenshots, smoke tests, and migration checks
- migration/backfill scripts are idempotent and documented
- environment variable reference is complete
- operator runbooks are tested by someone other than the implementer

## Suggested Production Milestones

### Milestone 1: Local And CI Green

Exit criteria:

- all workspace builds green
- backend/frontend/admin dev modes run
- dev smoke script passes
- focused class-session tests pass
- CI source of truth is confirmed

### Milestone 2: Single-Node Staging Pilot

Exit criteria:

- staging auth, API, sockets, TURN, and media work
- real teacher/student screenshots captured
- admin dashboard/modules smoke-tested
- security config validated
- backup/restore drill documented
- pilot risks accepted in writing

### Milestone 3: Paid-User Production

Exit criteria:

- staging soak/load signoff complete
- cross-browser signoff complete
- recording/playback/file-retention policies proven
- observability and runbooks are operator-ready
- data durability and restore proof complete

### Milestone 4: Large-Scale Multi-Node Production

Exit criteria:

- owner routing and pipe transport proven
- node drain tested
- Redis/Mongo behavior proven under expected load
- no cross-node event leakage
- multi-node incident runbooks tested

