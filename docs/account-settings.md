# Account settings

Signed-in students and teachers open **Account** in the website header or `/account/settings`. They can edit their display name, phone and time zone; appearance, date/number locale and display currency; notification and privacy preferences; and inspect or revoke active devices. Teacher phone/time-zone edits preserve tutor approval; public-facing name changes follow the existing review policy. Preference writes update only supplied fields, preserving simultaneous edits to other groups and classroom defaults. Stored legacy invalid locales fall back to the existing `en-US` default; new invalid locale writes are rejected.

## Credentials and devices

Password changes require the current password and matching new passwords, at least ten characters and at most 72 UTF-8 bytes. A completed account-settings password change invalidates every old device, including the current device, and pending password-reset links. The account must sign in again. The existing `/auth/change-password` endpoint retains its current-device behavior for compatible older clients.

Active devices are owner-scoped and paginated. Labels derive from the user agent and are descriptive rather than proof of a physical device. Signing out a device rejects its HTTP credentials immediately. Connected classroom sockets are checked in the existing 30-second sweep, using batched account and active-session reads. Reconnect authorization remains enforced. Revocation uses the normal room cleanup path.

A session now keeps one stable database row and `tokenId` through refreshes. Each rotation receives a random refresh-token nonce and stores a SHA-256 digest of the complete signed JWT with `refreshTokenHashVersion: 1`; no raw refresh token is stored. High-entropy signed tokens do not need a slow password hash. Legacy bcrypt refresh hashes remain accepted once and migrate on refresh. Compare-and-swap rotation cannot resurrect a revoked row. Replaying a used token revokes that device only. Account-wide security changes increment `authVersion`, which remains fail-closed even if session cleanup fails.

## Verified email

An account with a password can verify its existing address or request a new one after confirming the current password. Provider-only users first establish a password using the existing account recovery flow. The new address receives a one-use, 30-minute verification link. Opening it does not consume it; confirmation requires an explicit POST. The browser removes the fragment immediately, uses `no-referrer`, stores no token, and does not automatically log in.

Confirmation checks the original address and authentication version in the same Mongo transaction as token consumption. Changing the address increments `authVersion`, clears pending recovery tokens and queues a notice to the previous mailbox. Merely verifying the same address preserves sessions. Requests can be cancelled; stale, expired, consumed and cancelled links fail. Recipient conflicts fail without replacing the account. Existing purchase ownership stays attached to the account id and issued document email snapshots are preserved.

The durable `account_email_jobs` queue has a one-minute request cooldown, five accepted requests per hour, five delivery attempts and a two-minute crash-recovery lease. HTTP password-proof endpoints are also throttled. Only hashes of verification tokens are persisted. Recipient addresses are retained for pending confirmation/delivery, cleared on consumption/cancellation or completed notice delivery, and expire with the queue documents. Confirmation requests expire after one hour; old-address notices expire after seven days. Retrying delivery creates a new token, invalidating older attempts. SMTP ambiguous acknowledgements may produce duplicate messages; only the newest token works. Audit records exclude passwords, tokens and recipient addresses.

## Connected sign-in methods

Connecting Google or Apple requires the current account password, configured provider support, provider consent and a one-use browser-bound PKCE ticket. The server binds the flow to the account, device and credential version. It cannot be exchanged through the public login flow or attached from another account/device. Linking preserves the account email, name, role and tutor approval; another account's provider identity cannot be claimed. Disconnect requires a password and signs out every device. Provider-only accounts cannot remove their last sign-in method. Website linking is supported; native desktop users are directed to the website.

## Rollout and rollback

1. Build the backend and provision additive indexes with `npm run setup:account-settings`. Set `MONGODB_URI` or `MONGODB_URI_FILE`; use `-- --allow-remote` only for the reviewed target. The script preserves all documents and existing indexes. Run twice to confirm idempotence. MongoDB must support transactions (replica set or mongos).
2. Reuse the canonical `FRONTEND_URL` and SMTP settings from [account recovery](account-recovery.md). When SMTP is enabled, the backend requires account-email indexes at startup. Serve `/account/settings`, `/account/billing`, `/account/confirm-email` and `/account/link-provider` as SPA routes. Verify actual external email receipt and old-address notices in staging.
3. Deploy compatible session handling to every backend node together. Older code cannot refresh version-1 SHA-256 session hashes and its session-replacement behavior undermines stable device revocation. Retain both full-token hash support and `authVersion` checks in rollback builds; prefer a forward fix. Do not reset credential versions, rewrite session hashes or restore old tokens.
4. Google/Apple flags and merchant/provider secrets remain operator configuration. Follow [social sign-in](social-sign-in.md) for real provider consent and relay-email checks. Local fake-provider acceptance tests do not prove external provider configuration.

`npm run test:admin:integration` includes real database account and billing boundaries. `npm run test:account:browser` runs account/device/email/provider and billing workflows headlessly in Chromium, Firefox and WebKit, with mobile/light/dark screenshots, selected accessibility checks and failure traces under `reports/account/` and `test-results/account/`. CI retains evidence. External SMTP/provider delivery and physical-device testing remain deployment checks.

Design guidance: [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) and [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
