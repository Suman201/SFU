# Local tutor onboarding validation

Validated on 28 October 2026. There is no production environment. All applicants, evidence, videos, content reviewer declarations and emails in these tests are synthetic. A passing local report does not constitute real expert sign-off, identity verification or a real-teacher pilot.

## Results

- Shared contracts, Nest backend, Angular website and admin production builds passed.
- Backend regression suites: 41 tests passed for assessment approval/version invalidation, teaching areas, profiles and notifications.
- Focused frontend profile/teaching-area suites: 19 tests passed in headless Chrome.
- Encryption-key setup: two tests passed, including owner-only permissions, repeat-run preservation, invalid-key preservation and no key in console output.
- Full real-backend onboarding acceptance passed in Chromium and WebKit. The final admin form layout and email delivery count were additionally checked in Chromium after the visual correction.
- Development, multi-node and production Compose templates passed configuration syntax checks; backup/restore scripts passed shell syntax checks.

## Real-backend coverage

The browser tests start two Nest processes against isolated local MongoDB and Redis, with a loopback SMTP server. Application HTTP, database operations, filesystem operations and email delivery are real. The SMTP fixture rejects the first message transiently; the queue retries it. The two-process check confirmed one accepted email for each queued application status event in the tested run. Delivery remains at-least-once around process/provider failures as described in the operations guide.

Coverage includes private PNG/PDF uploads, invalid document rejection, owner/admin access, denial to anonymous users, students and another teacher, cross-process downloads, authenticated ciphertext tamper detection, private file permissions, retention deletion, download-before-verification, admin document review, tutor submission and approval, changes requested, rejection and resubmission, in-app read status, expert task/rubric approval, stale content invalidation, public redaction, readiness UI/CLI and public listing withdrawal when required evidence is removed.

The Chromium flow also exercised discovery of the approved teacher, free class enrollment, denied classroom access before enrollment, joining after teacher start, and teacher/student whiteboard sync through the real classroom backend with synthetic browser media. Paid checkout is outside this flow.

## Isolated restore drill

The repository backup/restore scripts ran with real `mongodump`/`mongorestore` in the local test MongoDB container. A synthetic source database was restored into a separate database namespace. Checksums passed; the private file decrypted with its original separately held key, video fixture bytes matched, and owner-only file permissions were preserved. The drill databases were then removed. No primary development database or production data was restored or replaced. A production restore drill remains required after provisioning that environment.

## Remaining human and environment work

Qualified reviewers must approve actual subject content and record real evidence checks. Recruit pilot teachers/students and complete [the pilot record](tutor-onboarding-pilot.md). Provision production, configure actual SMTP delivery and shared private storage, retain the encryption key separately, and repeat environment-specific checks using [the operations guide](tutor-onboarding-operations.md).
