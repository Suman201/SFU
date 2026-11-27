# Account recovery

Students, teachers and admin staff can choose **Forgot your password?** on their login screen. The shared form submits the account email and displays the same acknowledgement for known, unknown, disabled and deleted accounts. The desktop login opens the configured website's recovery page in the system browser.

An eligible account receives a link to choose and confirm a new password. Links expire after 30 minutes and work once. Only the latest issued link works. Opening a link never changes a password or signs anyone in. Successful reset requires a normal login with the new password and revokes earlier access and refresh sessions on every compatible backend node. Roles, tutor review, provider identities, enrollments and payments stay intact. Social-only accounts can establish a password by receiving a link at their registered mailbox, including an Apple private relay address when outbound relay delivery is configured.

## Configuration and rollout

Use the existing SMTP settings (`SMTP_ENABLED`, host/port/secure, credentials and sender; secret files remain supported). Configure two fixed portal origins:

```dotenv
FRONTEND_URL=https://learn.example.com
ADMIN_PORTAL_URL=https://admin.example.com
```

Both origins are required when SMTP is enabled. Production requires HTTPS, no URL credentials, paths, queries or fragments. Loopback HTTP is accepted only outside production. URLs come from configuration, never request Host/Forwarded headers. Student/teacher links use `FRONTEND_URL/reset-password`; admin links use `ADMIN_PORTAL_URL/reset-password`. Ensure both deployments serve SPA routes for `/forgot-password` and `/reset-password`.

1. Build the backend and run `npm run setup:account-recovery` against the reviewed database using `MONGODB_URI` or `MONGODB_URI_FILE`. Add `-- --allow-remote` for an explicitly reviewed remote target. Setup is repeatable, preserves accounts/indexes, and refuses conflicting uniqueness constraints instead of deleting data.
2. Configure the canonical origins and SMTP before enabling delivery. Enabled mail requires the recovery hash, queue lookup and queue expiry indexes at startup. With SMTP disabled, requests retain the generic response and do not queue email.
3. Deploy the backend version to **all** nodes before exposing recovery. The additive `authVersion` is interpreted as zero when absent from existing accounts/tokens. It has no write-back schema default, so saving a legacy document loaded before a reset cannot overwrite the new version. On reset it increments atomically with the password replacement and token consumption. Both access and refresh verification enforce it, including tokens issued in a concurrent login/refresh race. Session rows carry that version too: replay/cleanup is limited to the old credential epoch, so replaying an old refresh token cannot sign out a newly recovered session. Existing session rows are also marked revoked. Connected classroom sockets are swept every 30 seconds using batched account and active-device session reads per node; older recovery versions and inactive accounts are disconnected through the normal classroom cleanup path. If the database is unavailable, the sweep retries while reconnect authentication remains checked.
4. Verify reset and confirmation receipt at approved external QA mailboxes. Test both portals, teacher review, social-only/relay accounts and cross-node old-session rejection. Local SMTP acceptance cannot prove external sender-domain authentication, spam delivery or Apple relay configuration.

Reset tokens appear only in email and in-memory processing. The browser reads a fragment token, immediately removes it from history, uses `no-referrer`, and never stores the token or auto-logs in. Submit uses POST. Passwords must match in the UI, use at least ten characters and fit the existing bcrypt 72-byte capacity; overly long multibyte passwords are rejected rather than silently truncated. Password changes through the existing authenticated endpoint also invalidate pending reset links and cannot overwrite a concurrent recovery password using a stale password hash.

## Queue, retries and abuse controls

Public requests perform no account-existence lookup and do not wait for SMTP. They enqueue the same durable job for any valid address. A hashed-address unique job id enforces a one-minute cooldown and five accepted requests per hour. The HTTP endpoints additionally limit requests per source IP: ten reset-email requests and twenty reset submissions per minute. Account limits return the same 204 acknowledgement rather than revealing an account. No password/account is locked because someone requested recovery.

Each backend leases queued delivery atomically, with bounded attempts and exponential retry. Two workers cannot normally send the same job at once. Worker crashes recover after a two-minute lease; retries mint a new token, and the newer token supersedes earlier ones. As with SMTP generally, an ambiguous acknowledgement can produce more than one email; only the latest issued link remains valid. Requests in active delivery are not replaced. A completed reset blocks delivery of older pending requests. Confirmation messages are queued separately and never contain passwords or reset tokens.

The queue stores no plaintext reset tokens. It temporarily retains recipient addresses for delivery, then removes them on success, skip or final failure. Queue documents expire after 24 hours. The user reset-hash index is an ordinary unique sparse index: **there is no user TTL index**. Logical token expiry is always checked in the atomic password update. Legacy `password_reset_tokens` documents are no longer accepted; setup does not delete that old collection or invent migrated links.

Sensitive mail suppresses provider error bodies so an SMTP error cannot echo a reset link into logs/incidents. Audit events record requests and successful changes without tokens/passwords. Database outages fail requests uniformly; worker failures remain queued for retry. If session-row cleanup fails after the password commit, the authentication version still rejects older sessions. Confirmation-queue failures are logged without secrets and do not undo a completed password change.

## Verification and rollback

`npm run test:recovery:browser` runs headlessly in Chromium, Firefox and WebKit against two real backends, MongoDB, Redis and a local SMTP sink. It covers delivery after an initial failure, identical public responses, no unknown-account email, token hashing, URL removal, no automatic login, confirmation messages, teacher/admin/social-only accounts, cross-node access/refresh revocation, expiry/replay/concurrent consumption, replaced links, disabled accounts, limits, audit/log redaction, responsive layouts and accessibility. Screenshots and reports are under `reports/recovery/`; CI retains them with failure traces.

Backend tests cover token/credential boundaries, unsafe origins, duplicate cooldown handling, sensitive SMTP errors and revocation even if session-row cleanup fails. Shared-form tests cover acknowledgement, matching passwords, fragment removal and malformed links.

Rollback must preserve authentication-version enforcement once any account has recovered. Keep recovery fields and indexes and use a compatible build or forward fix. Do not restore old token-disclosing/reset handlers or a node that ignores credential versions. Never manually re-enable an old reset link.

Design guidance: [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html). Live SMTP and deployment acceptance remain required; repository tests do not authorize deployment.
