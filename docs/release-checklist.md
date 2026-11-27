# Product release checklist

Copy this checklist into the release record. Fill each evidence field with the commit, environment, operator, time and artifact link; unchecked items stay open. A documentation check verifies required sections, not approval.

## Source and checks

- [ ] Record source commit/tag, intended destination and green Product and admin CI URL.
- [ ] Confirm clean tree, expected contract baseline and reviewed additive/incompatible API classification.
- [ ] Capture production builds, unit/integration results and P0/P1/P2 browser reports with no required skips.
- [ ] Verify runtime API/socket URLs, TLS/CORS, secret files, authenticated operations and enrollment/staff access.

## Migration checks

- [ ] Record a current encrypted backup and target-storage restore proof before applying changes.
- [ ] Verify target MongoDB replica set/mongos and transaction support; no standalone publication fallback.
- [ ] Review `setup:cms`, `setup:payments`, `setup:invoices`, `setup:scheduling`, `setup:bookings`, `setup:admin-operations`, `setup:social-auth`, `setup:account-recovery` and `setup:account-settings` for the actual changes in the release. Run only applicable scripts on the reviewed target.
- [ ] Run applicable setup twice, inspect unique-index diagnostics and compare row counts/content. Resolve duplicate data explicitly; never delete records to force index creation.
- [ ] Confirm existing published pages, active sessions, reservations, invoices and recordings remain accessible only to permitted users.
- [ ] Coordinate backend/admin rollout for CMS working-copy semantics; do not expose draft fields through old public handlers.

## Screenshots and smoke tests

- [ ] Attach actual desktop, tablet and phone screenshots in light/dark themes; include CMS editing/history, public content, prejoin, chat and audit views.
- [ ] Verify publish, private draft edit, stale-write rejection, restore-to-draft and explicit republish on approved staging content.
- [ ] Verify readonly staff can inspect history and cannot write, support replies reach the configured receiver, and audit entries exclude content bodies/secrets.
- [ ] Verify teacher preset, locked entry/admission, student permission feedback, keyboard focus/Escape, English/Hindi controls, media, reconnect and whiteboard legibility.
- [ ] For password recovery, configure canonical website/admin origins and SMTP, provision recovery indexes, deploy compatible session-version checks to every backend node, and verify actual reset/confirmation email receipt.
- [ ] For account settings and billing, follow [account settings](account-settings.md) and [customer billing](customer-billing.md): provision email indexes, deploy stable-session/full-token-hash support to every node, verify email notices, purchaser-only document access, saved defaults and original-currency totals. Retain compatible refresh-hash and credential-version handling in rollback builds.
- [ ] When enabling Google/Apple, complete the [social sign-in live checklist](social-sign-in.md), provision identity/replay/TTL indexes, and verify teacher review and account-linking boundaries with real provider accounts.
- [ ] Capture actual staging TURN/ingress, provider and physical-device/screen-reader checks as applicable.

- [ ] For booking earnings, follow [the finance rollout](booking-earnings.md): provision indexes, configure per-currency payout minima, verify Stripe environments and booking dispute webhooks, review historical commission policies, and reconcile provider fees/FX before approving real transfers.

## Rollback

- [ ] Record the prior known-good image/config digests and rollback owner.
- [ ] Drain the affected node and preserve live-session/recording recovery before replacing application processes; use the operator runbook.
- [ ] Preserve additive CMS history collections/indexes and published snapshots. Use a compatible prior build or a forward fix that retains draft isolation. Do not restore an older public CMS handler over working-copy documents.
- [ ] For bad content, restore a known publication as draft and explicitly publish after review; unpublish if immediate public removal is necessary. Do not rewrite revision history.
- [ ] After recovery resets, retain the authentication-version checks in rollback builds; never restore handlers that ignore revoked credential versions or disclose reset tokens. Preserve additive recovery fields and indexes.
- [ ] To roll back enabled social sign-in, disable its provider flags and retain identity data/indexes and password-less account handling. Use a compatible backend or a forward fix; old password-only login code cannot safely handle provider-only accounts.
- [ ] Restore databases/artifacts only through the approved backup procedure with write coordination and target verification. Record RPO/RTO and reconcile provider payment/refund state before opening writes.
- [ ] Re-run health/readiness, authentication, public published copy, payment verification, classroom and recording smoke checks; retain incident evidence.

## Signoff

- [ ] Engineering reviewer: name, commit, evidence URL and time.
- [ ] Product/legal reviewer: approved copy, locale review and retention policy, with version references.
- [ ] Independent operator: name and actual runbook execution/restore evidence (cannot be the implementer self-signing).
- [ ] QA: staging and physical-device/assistive-technology evidence and any accepted limitations.
- [ ] Release owner: explicit production merge/deployment authorization, destination and rollout window. A main-branch push is not deployment authorization.

## Escalation

Complete these fields in the deployment's private release record; do not put personal contacts or credentials in the public repo.

| Responsibility | Named primary and backup | Receiver/runbook proof |
| --- | --- | --- |
| Release/rollback decision | Unassigned | Approved incident channel and paging delivery |
| Media/TURN/session recovery | Unassigned | Operator runbook and staging media evidence |
| Database/storage/restore | Unassigned | Target backup/restore owner and measured RPO/RTO |
| Payments/refunds/invoices | Unassigned | Merchant account operator and reconciliation procedure |
| Support/privacy/legal | Unassigned | Approved response path and retention/legal owner |

For failed payment verification, unintended content disclosure, access-control failure or media outage, halt rollout and contact the assigned release owner. Preserve redacted diagnostics, restrict the affected surface using existing controls, and follow rollback/recovery steps. Do not invent contact assignments or publish raw message bodies, tokens or provider secrets in incident artifacts.
