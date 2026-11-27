# Google and Apple sign-in

Google and Apple are optional website and native desktop sign-in providers for students and existing teachers. Both are disabled by default; their buttons appear on student login, teacher login and student registration only when the backend enables the provider. Email/password login continues to work without provider keys. Desktop login offers the same enabled providers with student/teacher selection; provider consent opens in the system browser. Email/password remains available.

New provider users can create student accounts. Teacher accounts must first be provisioned by the team, as with existing registration. Provider sign-in never grants teacher/admin roles, approves a tutor, changes enrollment or bypasses classroom permissions. Admin and super-admin accounts cannot use these student/teacher social endpoints.

## Enable after adding keys

1. Build the backend and run `npm run setup:social-auth` against the intended database. Supply `MONGODB_URI_FILE` for a mounted secret; a reviewed remote target additionally requires `-- --allow-remote`. This repeatable command creates unique provider identity indexes, unique OAuth state/ticket indexes and flow expiry. It never drops indexes or modifies existing accounts. Enabled providers fail startup if required indexes are absent.
2. Set `FRONTEND_URL` to the single HTTPS origin serving the learning portal. The fixed frontend completion URL is `/auth/social/callback`; serve that path through the SPA fallback. Set the callback URLs below to the public backend origin, which may be proxied through the same website. Production requires HTTPS without URL credentials, query parameters or fragments.
3. Configure provider keys privately and enable each provider separately. Restart the backend after changing configuration. Do not expose provider secrets in Angular environment files.
4. Complete the live provider checklist below before releasing enabled sign-in to learners. Local signed-provider tests do not establish that your provider/developer accounts, domains or consent screens are configured.

Google configuration:

```dotenv
GOOGLE_AUTH_ENABLED=true
GOOGLE_AUTH_CLIENT_ID=<web application client ID>
GOOGLE_AUTH_CLIENT_SECRET_FILE=/run/secrets/google-auth-client-secret
GOOGLE_AUTH_REDIRECT_URI=https://api.example.com/api/v1/auth/social/google/callback
```

Create an OAuth web application in Google Cloud, configure its consent screen/audience and register the exact redirect URI. Calendar sync uses separate `GOOGLE_CALENDAR_*` settings; enabling sign-in does not request calendar access or change calendar connections. See [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

Apple configuration:

```dotenv
APPLE_AUTH_ENABLED=true
APPLE_AUTH_CLIENT_ID=<Services ID>
APPLE_AUTH_TEAM_ID=<Apple team ID>
APPLE_AUTH_KEY_ID=<Sign in with Apple key ID>
APPLE_AUTH_PRIVATE_KEY_FILE=/run/secrets/apple-auth-private-key.p8
APPLE_AUTH_REDIRECT_URI=https://api.example.com/api/v1/auth/social/apple/callback
```

Configure the Services ID, associated Sign in with Apple App ID, website domains and exact return URL in Apple Developer. Use the downloaded EC P-256 `.p8` signing key as a mounted PEM file. The backend creates short-lived ES256 client secrets. Apple posts its callback as `application/x-www-form-urlencoded`; the reverse proxy/WAF must allow POST to that path without requiring the app's authorization or protocol headers. Register a real HTTPS domain for Apple; loopback simulation in tests is not Apple domain verification. Configure Apple private relay email delivery for your outgoing mail domains before relying on delivery to relay addresses. See [Apple web setup](https://developer.apple.com/documentation/signinwithapple/configuring-your-webpage-for-sign-in-with-apple) and [token validation](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens).

The direct `GOOGLE_AUTH_CLIENT_SECRET` and `APPLE_AUTH_PRIVATE_KEY` variables are also supported. Prefer `_FILE` secret mounts, especially for multiline PEM content. Disabled providers need no keys. An enabled provider with incomplete or unsafe configuration fails validation with variable names, never secret values.

## Account linking and recovery

A verified provider subject identifies an account; matching email alone never links accounts. To connect an existing email/password account, choose **Link an existing email/password account** on the completion page and confirm its current email and password. When a matching account exists, the page requests this proof before signing in. This also lets teachers link Apple private relay identities without changing their existing account email. Linking cannot replace a different identity from the same provider or bind an identity already owned by someone else.

Provider-only students initially have no password hash; password login fails cleanly. They can continue using their provider or use [account recovery](account-recovery.md) through the registered mailbox to establish a password. Website account settings support connecting and disconnecting providers, with current-password proof and protection for the last sign-in method; see [account settings](account-settings.md). Do not merge provider-only accounts by email or modify database identity fields manually as a recovery shortcut.

Apple's unsigned first-consent name is used only for display; email, issuer, audience, verification status and stable subject come from the verified token. Subsequent sign-ins preserve the account's display name. Provider access/refresh tokens are neither stored nor returned to the browser.

## Security and operations

The server stores hashed, expiring, one-use OAuth state and handoff tickets in MongoDB. Google uses PKCE. Both providers use a random nonce checked against the signed ID token, issuer/audience/algorithm/expiry checks and fixed provider token/key URLs. Apple uses its form-post callback. Website callbacks redirect only to the configured frontend origin. Native flows can return only to a validated temporary loopback listener; no app JWT or provider token is placed in a URL.

The browser holds an independent random verifier in session storage. Redeeming a handoff ticket requires that verifier, preventing an attacker from completing someone else's login in another browser. The fragment ticket is removed immediately on completion-page load. Provider consent has a ten-minute expiry; completion has two minutes and at most five exchanges, including failed credential confirmations. Refreshing the completion page requires starting again. Atomic claims prevent concurrent state/ticket reuse, including across backend nodes. No callback cookie is needed for Apple's cross-site POST.

Sign-in uses the normal rotating application sessions and Remember me behavior. Linked users are rechecked for disabled/deleted state and role before issuing sessions; existing access-token verification still rechecks account/session status. Registration, linking and sign-in are audited without provider credentials/tokens. Keep reverse proxy/access logging configured to omit callback query strings and bodies; the backend's request serializer logs sanitized paths. Rate limits apply to the public auth endpoints.

## Native desktop sign-in

The main process creates a fresh verifier and random callback path, listens on an OS-assigned port on `127.0.0.1` only, and posts the challenge plus `desktopRedirectUri` to the existing start endpoint. The server accepts only canonical `http://127.0.0.1:<1024–65535>/oauth/callback/<43-character nonce>` destinations and persists the destination with the one-use state. The registered Google/Apple redirect URI remains the existing HTTPS backend callback, including Apple's form POST; no new native provider client or callback registration is needed.

After provider token verification, the backend returns a two-minute handoff ticket to that listener. The main process accepts only the exact pending path/host, GET method and one valid ticket/error parameter. It closes the listener and delivers the ticket/verifier through trusted IPC. The desktop completion screen offers **Finish signing in** and explicit existing-account linking. Only the normal exchange endpoint can issue application sessions. Remember-me storage, disabled-account checks, teacher review state, role restrictions and safe class return paths use the existing auth service. No provider token, application JWT, client secret or private key is placed in a browser URL or installer.

Only the trusted main-frame desktop login page may initiate the IPC flow; the main process opens only the exact HTTPS Google/Apple consent endpoints. Closing/reloading/crashing the window, local cancellation or ten-minute expiry aborts startup and closes the listener. Late results cannot reopen consent or replace another attempt. Invalid, expired or replayed callbacks fail without signing in. Credentials and handoff data remain in memory and are discarded on completion, cancellation or leaving the login screen.

This follows [OAuth for native apps](https://www.rfc-editor.org/rfc/rfc8252.html) and [Electron's external navigation guidance](https://www.electronjs.org/docs/latest/tutorial/security/). The OS browser must be able to reach the deployed backend and local callback. Deploy the updated backend before distributing an updated desktop installer; an older backend will reject the new optional start field cleanly.

## Automated evidence and live checklist

Run `npm run build:admin-ci`, `npm run build -w @native-sfu/frontend -- --configuration desktop`, backend/frontend unit suites, `node scripts/p0-ci-services.cjs up`, then `npm run test:social:browser`. The browser suite owns only the existing local acceptance databases/services and runs headlessly in Chromium, Firefox and WebKit. It uses a loopback provider simulator with signed RSA ID tokens, verifies the real Apple ES256 client secret and Google PKCE, and exercises the real Angular, backend and MongoDB flows. A test-only Node preload maps outbound provider exchanges to this simulator; application provider URLs cannot be overridden by runtime environment variables. Never load that fixture in a deployment.

Coverage includes the actual desktop bundle and local API proxy with native controller/loopback integration through a headless IPC/browser adapter, native light/dark/narrow screenshots, both roles/providers, new student accounts, teacher private relay linking, incorrect password rejection, matching-email collision, unchanged tutor review, wrong-role/admin/disabled-account rejection, invalid nonce/audience/unverified email, callback cancellation, state replay, browser binding, concurrent ticket redemption, expiry, duplicate identity indexes, audit privacy, accessible controls and narrow layouts. Token unit tests also reject wrong issuer, expired/future/invalid/HMAC tokens and unknown keys. Reports and actual UI screenshots are under `reports/social/` and in CI artifacts.

Before enabling in a deployment, verify with real consent screens and accounts:

- Exact public callback origins/paths, HTTPS, consent audience and Google test-user/publishing status.
- New and existing student sign-in with each provider; explicit linking does not create duplicate accounts.
- Existing teacher sign-in with each provider; draft/submitted/approved review state remains unchanged.
- Apple first and returning consent, Hide My Email and relay delivery; cancellation and retry.
- Logout, remembered sessions, refresh, disabled accounts, safe return paths and normal enrollment/classroom access.
- Key rotation/revocation, operational logging redaction and a second backend node against the same flow store.

Live provider acceptance is pending until credentials and domains are supplied. Signed macOS/Windows system-browser handoff with real provider accounts still needs acceptance after credentials and domains are supplied; headless adapter tests do not prove OS focus, firewall or installer behavior. No deployment is implied by repository test results.
